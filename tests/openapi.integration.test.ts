import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '../src/db/schema.js';
import { apiKeys, tenants } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/auth/key.js';
import { PermanentDeliveryError, type Channel } from '../src/channel.js';
import { processNotification } from '../src/worker-service.js';
import { conformanceProblems, schemaErrors, spec } from './openapi-helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fakeRedis: any = { on() {}, subscribe: async () => 1, unsubscribe: async () => 1, quit: async () => 'OK', removeAllListeners() {} };

// Real requests, real Postgres. Every response is checked against docs/openapi.yaml: a status the spec does not list, a
// header it promises that is missing, or a body that does not match its schema fails the test.
describe('the API behaves as docs/openapi.yaml says', () => {
  let postgres: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: ReturnType<typeof buildApp>;
  const problems: string[] = [];
  const auth = { authorization: 'Bearer ntf_live_oas_a' };
  const queue = {
    add: vi.fn().mockResolvedValue({}),
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0 }),
  };

  beforeEach(() => { problems.length = 0; }); // each test is judged on its own responses

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    const [tenant] = await db.insert(tenants).values({ name: 'OAS' }).returning();
    await db.insert(apiKeys).values({ tenantId: tenant!.id, keyHash: hashApiKey('ntf_live_oas_a') });
    app = buildApp(db, queue, { stream: { secret: 's'.repeat(32), subscriber: fakeRedis }, metricsToken: 'secret-token' });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await postgres?.stop();
  }, 120_000);

  /** Sends a request, checks the status is the expected one and the response conforms, and returns the parsed body. */
  async function call(method: string, template: string, url: string, expected: number, options: { headers?: Record<string, string>; payload?: unknown; app?: typeof app } = {}) {
    const res = await (options.app ?? app).inject({ method: method as any, url, headers: options.headers ?? auth, ...(options.payload !== undefined ? { payload: options.payload as any } : {}) });
    problems.push(...conformanceProblems(method, template, res as any));
    expect(res.statusCode, `${method} ${url}: ${res.body.slice(0, 160)}`).toBe(expected);
    return { res, body: res.headers['content-type']?.toString().includes('json') && res.body ? res.json() : res.body };
  }

  it('answers every request in a realistic session the way the spec describes', async () => {
    // --- users and templates
    const user = (await call('PUT', '/v1/users/{externalUserId}', '/v1/users/dana', 200, { payload: { email: 'dana@example.test' } })).body;
    await call('PUT', '/v1/users/{externalUserId}', '/v1/users/dana', 400, { payload: { email: 'not-an-email' } });
    await call('PUT', '/v1/users/{externalUserId}', '/v1/users/dana', 401, { headers: {}, payload: { email: 'dana@example.test' } });
    await call('POST', '/v1/templates', '/v1/templates', 201, { payload: { name: 'welcome', subject: 'Hi {{name}}', body: '<p>{{name}}</p>', variables: ['name'] } });
    await call('POST', '/v1/templates', '/v1/templates', 409, { payload: { name: 'welcome', body: 'again' } }); // the name is taken
    await call('POST', '/v1/templates', '/v1/templates', 400, { payload: { name: '', body: '' } });
    expect((await call('GET', '/v1/templates', '/v1/templates', 200)).body.templates).toHaveLength(1);

    // --- sending, idempotency and the error answers
    const create = (payload: unknown, headers: Record<string, string> = auth) => ({ headers, payload });
    const note = (await call('POST', '/v1/notifications', '/v1/notifications', 201, create({ externalUserId: 'dana', type: 'hello', payload: { title: 'Hi' }, channels: ['email', 'in_app'] }))).body;
    const keyed = { ...auth, 'idempotency-key': 'oas-key-1' };
    const body = { externalUserId: 'dana', type: 'keyed', payload: {}, channels: ['in_app'] };
    await call('POST', '/v1/notifications', '/v1/notifications', 201, create(body, keyed));
    await call('POST', '/v1/notifications', '/v1/notifications', 200, create(body, keyed)); // the replay, with its header
    await call('POST', '/v1/notifications', '/v1/notifications', 422, create({ ...body, type: 'different' }, keyed)); // same key, other body
    await call('POST', '/v1/notifications', '/v1/notifications', 422, create({ externalUserId: 'nobody', type: 't', payload: {} }));
    await call('POST', '/v1/notifications', '/v1/notifications', 422, create({ externalUserId: 'dana', type: 't', payload: {}, templateName: 'nope' }));
    await call('POST', '/v1/notifications', '/v1/notifications', 422, create({ externalUserId: 'dana', type: 't', payload: {}, templateName: 'welcome', variables: {} }));
    await call('POST', '/v1/notifications', '/v1/notifications', 400, create({ type: 't', payload: {} })); // no recipient
    await call('POST', '/v1/notifications', '/v1/notifications', 400, create({ userId: user.id, externalUserId: 'dana', type: 't', payload: {} })); // two recipients
    await call('POST', '/v1/notifications', '/v1/notifications', 401, create({ externalUserId: 'dana', type: 't', payload: {} }, {}));
    const templated = (await call('POST', '/v1/notifications', '/v1/notifications', 201, create({ userId: user.id, type: 'welcome', payload: {}, templateName: 'welcome', variables: { name: 'Dana' } }))).body;

    // --- delivery produces attempts, an inbox item, and (for a permanent failure) a dead letter
    const email: Channel = { name: 'test-email', send: async () => undefined };
    const publisher = { publish: async () => undefined };
    await processNotification(db, email, note.id, { publisher });
    const detail = (await call('GET', '/v1/notifications/{id}', `/v1/notifications/${note.id}`, 200)).body;
    expect(detail.status).toBe('delivered');
    expect(detail.deliveryAttempts.length).toBeGreaterThan(0);
    await call('GET', '/v1/notifications/{id}', '/v1/notifications/not-a-uuid', 400);
    await call('GET', '/v1/notifications/{id}', '/v1/notifications/00000000-0000-4000-8000-000000000000', 404);

    vi.spyOn(console, 'error').mockImplementation(() => undefined); // the permanent failure below is logged on purpose
    const refusing: Channel = { name: 'test-email', send: async () => { throw new PermanentDeliveryError('no such mailbox'); } };
    await processNotification(db, refusing, templated.id, { publisher });
    const dead = (await call('GET', '/v1/dead-letters', '/v1/dead-letters', 200)).body;
    expect(dead.notifications.map((n: any) => n.id)).toContain(templated.id);
    await call('POST', '/v1/notifications/{id}/replay', `/v1/notifications/${templated.id}/replay`, 202);
    await call('POST', '/v1/notifications/{id}/replay', `/v1/notifications/${templated.id}/replay`, 409); // no longer failed
    await call('POST', '/v1/notifications/{id}/replay', '/v1/notifications/00000000-0000-4000-8000-000000000000/replay', 404);
    await call('POST', '/v1/notifications/{id}/replay', '/v1/notifications/nope/replay', 400);

    // --- listing
    const page = (await call('GET', '/v1/notifications', '/v1/notifications?limit=2', 200)).body;
    expect(page.notifications).toHaveLength(2);
    expect(page.nextBefore).not.toBeNull();
    await call('GET', '/v1/notifications', `/v1/notifications?limit=2&before=${encodeURIComponent(page.nextBefore)}`, 200);
    await call('GET', '/v1/notifications', '/v1/notifications?status=delivered', 200);
    await call('GET', '/v1/notifications', '/v1/notifications?status=bogus', 400);

    // --- preferences
    await call('GET', '/v1/users/{externalUserId}/preferences', '/v1/users/dana/preferences', 200);
    const prefs = { preferences: [{ channel: '*', type: '*', quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' } }, { channel: 'email', type: 'promo', enabled: false }] };
    expect(schemaErrors(spec.components.schemas.PreferencesInput, prefs)).toBeNull();
    expect((await call('PUT', '/v1/users/{externalUserId}/preferences', '/v1/users/dana/preferences', 200, { payload: prefs })).body.preferences).toHaveLength(2);
    await call('GET', '/v1/users/{externalUserId}/preferences', '/v1/users/dana/preferences', 200);
    await call('PUT', '/v1/users/{externalUserId}/preferences', '/v1/users/dana/preferences', 400, { payload: { preferences: [{ channel: 'sms', type: 'x' }] } });
    await call('PUT', '/v1/users/{externalUserId}/preferences', '/v1/users/dana/preferences', 400, { payload: { preferences: [{ channel: 'email', type: 'a' }, { channel: 'email', type: 'a' }] } });
    await call('PUT', '/v1/users/{externalUserId}/preferences', '/v1/users/nobody/preferences', 404, { payload: { preferences: [] } });
    await call('GET', '/v1/users/{externalUserId}/preferences', '/v1/users/nobody/preferences', 404);

    // --- inbox
    const inbox = (await call('GET', '/v1/users/{externalUserId}/inbox', '/v1/users/dana/inbox', 200)).body;
    expect(inbox.notifications.map((n: any) => n.id)).toContain(note.id);
    await call('POST', '/v1/users/{externalUserId}/inbox/{id}/read', `/v1/users/dana/inbox/${note.id}/read`, 204);
    await call('POST', '/v1/users/{externalUserId}/inbox/{id}/read', '/v1/users/dana/inbox/00000000-0000-4000-8000-000000000000/read', 404);
    await call('POST', '/v1/users/{externalUserId}/inbox/{id}/read', `/v1/users/nobody/inbox/${note.id}/read`, 404);
    await call('POST', '/v1/users/{externalUserId}/inbox/{id}/read', '/v1/users/dana/inbox/nope/read', 400);
    await call('GET', '/v1/users/{externalUserId}/inbox', '/v1/users/nobody/inbox', 404);

    // --- real time
    await call('POST', '/v1/users/{externalUserId}/stream-token', '/v1/users/dana/stream-token', 200);
    await call('POST', '/v1/users/{externalUserId}/stream-token', '/v1/users/nobody/stream-token', 404);

    // --- dashboard
    const stats = (await call('GET', '/v1/stats', '/v1/stats?hours=24', 200)).body;
    expect(stats.notifications.delivered).toBeGreaterThanOrEqual(1);
    await call('GET', '/v1/stats', '/v1/stats', 200);
    await call('GET', '/v1/stats', '/v1/stats?hours=0', 400);
    const created = (await call('POST', '/v1/api-keys', '/v1/api-keys', 201)).body;
    expect((await call('GET', '/v1/api-keys', '/v1/api-keys', 200)).body.apiKeys).toHaveLength(2);
    await call('DELETE', '/v1/api-keys/{id}', `/v1/api-keys/${created.id}`, 204);
    await call('DELETE', '/v1/api-keys/{id}', `/v1/api-keys/${created.id}`, 204); // repeating is fine
    await call('DELETE', '/v1/api-keys/{id}', '/v1/api-keys/00000000-0000-4000-8000-000000000000', 404);
    await call('DELETE', '/v1/api-keys/{id}', '/v1/api-keys/nope', 400);
    const [active] = (await call('GET', '/v1/api-keys', '/v1/api-keys', 200)).body.apiKeys.filter((k: any) => !k.revokedAt);
    await call('DELETE', '/v1/api-keys/{id}', `/v1/api-keys/${active.id}`, 409); // the last one

    // --- erasing a user, twice
    await call('DELETE', '/v1/users/{externalUserId}', '/v1/users/dana', 204);
    await call('DELETE', '/v1/users/{externalUserId}', '/v1/users/dana', 204);
    await call('DELETE', '/v1/users/{externalUserId}', '/v1/users/dana', 401, { headers: {} });

    // --- operations
    await call('GET', '/health', '/health', 200, { headers: {} });
    await call('GET', '/ready', '/ready', 200, { headers: {} });
    await call('GET', '/metrics', '/metrics', 401, { headers: {} });
    const metrics = await call('GET', '/metrics', '/metrics', 200, { headers: { authorization: 'Bearer secret-token' } });
    // The user (and so every notification) was erased above, so there are no samples left; the metrics are still defined.
    expect(metrics.body).toContain('# TYPE notifications gauge');
    expect(metrics.body).toContain('# TYPE notification_queue_jobs gauge');

    expect(problems, 'responses that do not match docs/openapi.yaml').toEqual([]);
  }, 120_000);

  it('answers 503 for readiness when a dependency is down, and says which', async () => {
    const down = buildApp(db, { add: vi.fn(), getJobCounts: vi.fn().mockRejectedValue(new Error('redis down')) });
    await down.ready();
    const { body } = await call('GET', '/ready', '/ready', 503, { headers: {}, app: down });
    expect(body.checks.redis).toBe(false);
    await down.close();
    expect(problems).toEqual([]);
  });

  it('answers 429 with Retry-After, as documented', async () => {
    const limited = buildApp(db, queue, { rateLimiter: { take: async () => ({ allowed: false, retryAfterSeconds: 7 }) } });
    await limited.ready();
    const { res } = await call('GET', '/v1/stats', '/v1/stats', 429, { app: limited });
    expect(res.headers['retry-after']).toBe('7');
    await limited.close();
    expect(problems).toEqual([]);
  });

  it('answers 503 with the saved id when the queue is down, as documented', async () => {
    const broken = buildApp(db, { add: vi.fn().mockRejectedValue(new Error('redis down')) });
    await broken.ready();
    await call('PUT', '/v1/users/{externalUserId}', '/v1/users/erin', 200, { payload: { email: 'erin@example.test' }, app: broken });
    const { body } = await call('POST', '/v1/notifications', '/v1/notifications', 503, { payload: { externalUserId: 'erin', type: 't', payload: {} }, app: broken });
    expect(body.id).toBeTruthy();
    expect(body.error.code).toBe('QUEUE_UNAVAILABLE');
    await broken.close();
    expect(problems).toEqual([]);
  });
});
