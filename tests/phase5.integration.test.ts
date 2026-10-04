import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { DelayedError, type Job } from 'bullmq';
import * as schema from '../src/db/schema.js';
import { apiKeys, deliveryAttempts, notifications, tenants, users } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/auth/key.js';
import type { Channel, EmailMessage } from '../src/channel.js';
import type { InboxItem } from '../src/inbox.js';
import { listInbox } from '../src/inbox.js';
import type { InAppPublisher } from '../src/realtime.js';
import { createJobHandler, processNotification } from '../src/worker-service.js';

// No worker or Redis here: delivery is driven by calling processNotification directly, so time (quiet hours) and ordering are deterministic.
describe('preferences, quiet hours, digests and management API', () => {
  let postgres: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: ReturnType<typeof buildApp>;
  let tenantId: string;
  let userId: string;
  const add = vi.fn().mockResolvedValue({});
  const sent: EmailMessage[] = [];
  const pushed: InboxItem[] = [];
  const channel: Channel = { name: 'test-email', send: async (m) => { sent.push(m); } };
  const publisher: InAppPublisher = { publish: async (_u, item) => { pushed.push(item); } };
  const auth = { authorization: 'Bearer ntf_live_p5_a' };

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    const [t] = await db.insert(tenants).values({ name: 'P5' }).returning();
    tenantId = t!.id;
    await db.insert(apiKeys).values({ tenantId, keyHash: hashApiKey('ntf_live_p5_a') });
    const [u] = await db.insert(users).values({ tenantId, externalUserId: 'dana', email: 'dana@example.test' }).returning();
    userId = u!.id;
    app = buildApp(db, { add });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await postgres?.stop();
  }, 120_000);

  const setPrefs = (preferences: unknown[]) => app.inject({ method: 'PUT', url: '/v1/users/dana/preferences', headers: auth, payload: { preferences } });
  const send = async (payload: object) => {
    const res = await app.inject({ method: 'POST', url: '/v1/notifications', headers: auth, payload: { userId, type: 'comment', payload: {}, ...payload } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const row = async (id: string) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;
  const attemptsOf = async (id: string) => (await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.notificationId, id))).map((a) => `${a.channel}:${a.status}`).sort();
  const run = (id: string, now?: Date) => processNotification(db, channel, id, { publisher, ...(now ? { now } : {}) });
  const reset = async () => { sent.length = 0; pushed.length = 0; await setPrefs([]); };

  it('stores and replaces preferences, rejecting bad input', async () => {
    const quietHours = { start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' };
    expect((await setPrefs([{ channel: 'email', type: 'promo', enabled: false }, { channel: '*', type: '*', quietHours }])).statusCode).toBe(200);
    const got = await app.inject({ method: 'GET', url: '/v1/users/dana/preferences', headers: auth });
    expect(got.json().preferences).toHaveLength(2);
    expect((await setPrefs([{ channel: 'email', type: 'a' }, { channel: 'email', type: 'a' }])).statusCode).toBe(400);
    expect((await setPrefs([{ channel: 'sms', type: 'a' }])).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/users/nobody/preferences', headers: auth })).statusCode).toBe(404);
    expect((await setPrefs([])).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/users/dana/preferences', headers: auth })).json().preferences).toEqual([]);
  });

  it('skips opted-out channels, delivering the rest, and suppresses when nothing is left', async () => {
    await reset();
    await setPrefs([{ channel: 'email', type: 'promo', enabled: false }]);
    const mixed = await send({ type: 'promo', channels: ['email', 'in_app'] });
    await run(mixed);
    expect((await row(mixed)).status).toBe('delivered');
    expect(await attemptsOf(mixed)).toEqual(['in_app:sent', 'test-email:skipped']);
    expect(sent).toHaveLength(0);
    expect(pushed).toHaveLength(1);

    const onlyEmail = await send({ type: 'promo', channels: ['email'] });
    await run(onlyEmail);
    expect((await row(onlyEmail)).status).toBe('suppressed');
    expect(sent).toHaveLength(0);

    const otherType = await send({ type: 'receipt', channels: ['email'] }); // opt-out is per type
    await run(otherType);
    expect((await row(otherType)).status).toBe('delivered');
    expect(sent).toHaveLength(1);
  });

  it('delays during quiet hours instead of dropping, then delivers once the window ends', async () => {
    await reset();
    await setPrefs([{ channel: 'email', type: '*', quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' } }]);
    const id = await send({ channels: ['email'] });

    const night = new Date('2026-01-01T17:00:00Z'); // 22:30 in Kolkata
    await expect(run(id, night)).rejects.toMatchObject({ until: new Date('2026-01-02T01:30:00Z') });
    const deferred = await row(id);
    expect(deferred).toMatchObject({ status: 'queued', attempts: 0 }); // attempt refunded: nothing was tried
    expect(deferred.deliverAfter).toEqual(new Date('2026-01-02T01:30:00Z'));
    expect(sent).toHaveLength(0);

    await run(id, new Date('2026-01-02T01:31:00Z'));
    expect((await row(id)).status).toBe('delivered');
    expect(sent).toHaveLength(1);
  });

  it('turns a deferral into a delayed BullMQ job rather than a failure', async () => {
    await reset();
    const hhmm = (offsetHours: number) => new Date(Date.now() + offsetHours * 3600_000).toISOString().slice(11, 16);
    await setPrefs([{ channel: 'email', type: '*', quietHours: { start: hhmm(-1), end: hhmm(1), timezone: 'UTC' } }]); // a window around "now"; wraps midnight when needed
    const id = await send({ channels: ['email'] });
    const job = { data: { notificationId: id }, moveToDelayed: vi.fn().mockResolvedValue(undefined) } as unknown as Job;
    await expect(createJobHandler(db, channel, publisher)(job, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
    expect((await row(id)).status).toBe('queued');
  });

  it('delivers a digest window as one notification and keeps members out of the inbox', async () => {
    await reset();
    const ids = [];
    for (const title of ['Ann replied', 'Bo replied', 'Cy replied']) {
      ids.push(await send({ type: 'comment', channels: ['email', 'in_app'], payload: { title }, digestKey: 'comments:post-42', digestWindowSeconds: 60 }));
    }
    expect(add).toHaveBeenLastCalledWith('deliver-notification', { notificationId: ids[2] }, expect.objectContaining({ delay: 60_000 }));
    expect((await row(ids[0]!)).deliverAfter).not.toBeNull();

    await run(ids[0]!); // the first job to run closes the window
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('3 new comment notifications');
    expect(sent[0]!.html).toContain('Ann replied');
    expect(sent[0]!.html).toContain('Cy replied');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ id: ids[0], count: 3 });
    for (const id of ids) expect((await row(id)).status).toBe('delivered');
    expect((await row(ids[1]!)).digestParentId).toBe(ids[0]);

    await run(ids[1]!); // their own delayed jobs later find nothing to do
    await run(ids[2]!);
    expect(sent).toHaveLength(1);
    const inbox = await listInbox(db, tenantId, userId);
    expect(inbox.filter((i) => [ids[0], ids[1], ids[2]].includes(i.id!))).toEqual([expect.objectContaining({ id: ids[0], count: 3 })]);
  }, 30_000);

  it('does not digest different keys together and leaves a lone notification as is', async () => {
    await reset();
    const a = await send({ channels: ['email'], payload: { title: 'A' }, digestKey: 'k1' });
    const b = await send({ channels: ['email'], payload: { title: 'B' }, digestKey: 'k2' });
    await run(a);
    expect((await row(b)).status).toBe('queued');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('comment'); // count of 1 is sent normally, not as "1 new ..."
    expect((await row(a)).digestCount).toBe(1);
  });

  it('serves dashboard stats and a filterable, paginated log', async () => {
    const stats = await app.inject({ method: 'GET', url: '/v1/stats?hours=1', headers: auth });
    expect(stats.statusCode).toBe(200);
    const n = stats.json().notifications;
    expect(n.delivered).toBeGreaterThan(0);
    expect(n.suppressed).toBeGreaterThan(0);
    expect(stats.json().attempts.some((a: { status: string }) => a.status === 'skipped')).toBe(true);

    const delivered = await app.inject({ method: 'GET', url: '/v1/notifications?status=delivered&limit=2', headers: auth });
    const page1 = delivered.json();
    expect(page1.notifications).toHaveLength(2);
    expect(page1.notifications.every((x: { status: string }) => x.status === 'delivered')).toBe(true);
    const page2 = (await app.inject({ method: 'GET', url: `/v1/notifications?status=delivered&limit=2&before=${encodeURIComponent(page1.nextBefore)}`, headers: auth })).json();
    expect(page2.notifications.map((x: { id: string }) => x.id)).not.toEqual(expect.arrayContaining(page1.notifications.map((x: { id: string }) => x.id)));
    expect((await app.inject({ method: 'GET', url: '/v1/notifications?status=bogus', headers: auth })).statusCode).toBe(400);
  });

  it('manages API keys: create, authenticate, list, revoke, never the last one', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: auth });
    expect(created.statusCode).toBe(201);
    const { id, key } = created.json();
    expect(key).toMatch(/^ntf_live_/);
    expect((await app.inject({ method: 'GET', url: '/v1/dead-letters', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);

    const listed = (await app.inject({ method: 'GET', url: '/v1/api-keys', headers: auth })).json().apiKeys;
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(key); // plaintext is shown once only

    expect((await app.inject({ method: 'DELETE', url: `/v1/api-keys/${id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/dead-letters', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/v1/api-keys/${id}`, headers: auth })).statusCode).toBe(204); // idempotent

    const [only] = (await app.inject({ method: 'GET', url: '/v1/api-keys', headers: auth })).json().apiKeys.filter((k: { revokedAt: string | null }) => !k.revokedAt);
    const last = await app.inject({ method: 'DELETE', url: `/v1/api-keys/${only.id}`, headers: auth });
    expect(last.statusCode).toBe(409);
    expect(last.json().error.code).toBe('LAST_ACTIVE_KEY');
    expect((await app.inject({ method: 'DELETE', url: `/v1/api-keys/00000000-0000-4000-8000-000000000000`, headers: auth })).statusCode).toBe(404);
  });
});
