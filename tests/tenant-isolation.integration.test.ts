import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

// Tenant B tries to see or touch what belongs to tenant A through every read/list/mutate route. Postgres only; enqueueing is a stub.
describe('tenant isolation', () => {
  let postgres: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: ReturnType<typeof buildApp>;
  const a = { authorization: 'Bearer ntf_live_iso_a' };
  const b = { authorization: 'Bearer ntf_live_iso_b' };
  let aUser: string;
  let aNote: string;
  let aDead: string;

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: typeof a, payload?: object) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    const [ta] = await db.insert(tenants).values({ name: 'A' }).returning();
    const [tb] = await db.insert(tenants).values({ name: 'B' }).returning();
    await db.insert(apiKeys).values([{ tenantId: ta!.id, keyHash: hashApiKey('ntf_live_iso_a') }, { tenantId: tb!.id, keyHash: hashApiKey('ntf_live_iso_b') }]);
    app = buildApp(db, { add: vi.fn().mockResolvedValue({}) });
    await app.ready();

    aUser = (await call('PUT', '/v1/users/ann', a, { email: 'ann@example.test' })).json().id;
    aNote = (await call('POST', '/v1/notifications', a, { userId: aUser, type: 'note', payload: { title: 'secret of A' }, channels: ['in_app'] })).json().id;
    aDead = (await call('POST', '/v1/notifications', a, { userId: aUser, type: 'bad', payload: {}, channels: ['email'] })).json().id;
    await processNotification(db, { name: 'ok', send: vi.fn() } as Channel, aNote, { publisher: { publish: vi.fn().mockResolvedValue(undefined) } });
    const failing: Channel = { name: 'bad', send: vi.fn().mockRejectedValue(new PermanentDeliveryError('nope')) };
    await processNotification(db, failing, aDead);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await postgres?.stop();
  }, 120_000);

  it('baseline: tenant A sees its own notification, dead letter and inbox item', async () => {
    expect((await call('GET', `/v1/notifications/${aNote}`, a)).statusCode).toBe(200);
    expect((await call('GET', '/v1/dead-letters', a)).json().notifications.map((n: { id: string }) => n.id)).toContain(aDead);
    expect((await call('GET', '/v1/users/ann/inbox', a)).json().notifications.map((n: { id: string }) => n.id)).toContain(aNote);
  });

  it("cannot read tenant A's notification by id", async () => {
    expect((await call('GET', `/v1/notifications/${aNote}`, b)).statusCode).toBe(404);
  });

  it("does not list tenant A's notifications, dead letters or stats", async () => {
    expect((await call('GET', '/v1/notifications', b)).json().notifications).toEqual([]);
    expect((await call('GET', '/v1/dead-letters', b)).json().notifications).toEqual([]);
    const stats = (await call('GET', '/v1/stats', b)).json();
    expect(Object.values(stats.notifications as Record<string, number>).reduce((sum, n) => sum + n, 0)).toBe(0);
  });

  it("cannot reach tenant A's user: inbox, read receipt, preferences and erase", async () => {
    expect((await call('GET', '/v1/users/ann/inbox', b)).statusCode).toBe(404);
    expect((await call('POST', `/v1/users/ann/inbox/${aNote}/read`, b)).statusCode).toBe(404);
    expect((await call('GET', '/v1/users/ann/preferences', b)).statusCode).toBe(404);
    await call('DELETE', '/v1/users/ann', b); // 204 whether or not the user exists in B; must not touch A's
    expect((await call('GET', `/v1/notifications/${aNote}`, a)).statusCode).toBe(200);
  });

  it("a same-named user in tenant B is a different user with an empty inbox", async () => {
    await call('PUT', '/v1/users/ann', b, { email: 'other-ann@example.test' });
    expect((await call('GET', '/v1/users/ann/inbox', b)).json().notifications).toEqual([]);
    expect((await call('POST', `/v1/users/ann/inbox/${aNote}/read`, b)).statusCode).toBe(404); // A's notification id is not B's
  });

  it("cannot send to tenant A's user id or replay A's dead letter", async () => {
    expect((await call('POST', '/v1/notifications', b, { userId: aUser, type: 'x', payload: {} })).statusCode).toBe(422);
    expect((await call('POST', `/v1/notifications/${aDead}/replay`, b)).statusCode).toBe(404);
  });

  it('the same Idempotency-Key in two tenants creates two separate notifications', async () => {
    const bUser = (await call('PUT', '/v1/users/bob', b, { email: 'bob@example.test' })).json().id;
    const send = (headers: typeof a, userId: string) => app.inject({ method: 'POST', url: '/v1/notifications', headers: { ...headers, 'idempotency-key': 'shared-key' }, payload: { userId, type: 'k', payload: {} } });
    const first = await send(a, aUser);
    const second = await send(b, bUser);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(first.json().id);
  });

  it("a revoked key stops working, and another tenant's key cannot revoke it", async () => {
    const created = (await call('POST', '/v1/api-keys', a)).json();
    const keyHeader = { authorization: `Bearer ${created.key}` };
    expect((await call('GET', '/v1/stats', keyHeader)).statusCode).toBe(200);
    expect((await call('DELETE', `/v1/api-keys/${created.id}`, b)).statusCode).toBe(404);
    expect((await call('GET', '/v1/stats', keyHeader)).statusCode).toBe(200);
    expect((await call('DELETE', `/v1/api-keys/${created.id}`, a)).statusCode).toBe(204);
    expect((await call('GET', '/v1/stats', keyHeader)).statusCode).toBe(401);
  });
});
