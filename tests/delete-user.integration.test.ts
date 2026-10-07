import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import { apiKeys, tenants, users } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/auth/key.js';
import type { Channel } from '../src/channel.js';
import { processNotification } from '../src/worker-service.js';

// Postgres only: delivery is driven by calling processNotification directly, and enqueueing is a stub.
describe('erasing a user', () => {
  let postgres: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: ReturnType<typeof buildApp>;
  let tenantA: string;
  let tenantB: string;
  const channel: Channel = { name: 'test-email', send: vi.fn().mockResolvedValue(undefined) };
  const a = { authorization: 'Bearer ntf_live_del_a' };
  const b = { authorization: 'Bearer ntf_live_del_b' };

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    const [ta] = await db.insert(tenants).values({ name: 'A' }).returning();
    const [tb] = await db.insert(tenants).values({ name: 'B' }).returning();
    tenantA = ta!.id;
    tenantB = tb!.id;
    await db.insert(apiKeys).values([{ tenantId: tenantA, keyHash: hashApiKey('ntf_live_del_a') }, { tenantId: tenantB, keyHash: hashApiKey('ntf_live_del_b') }]);
    app = buildApp(db, { add: vi.fn().mockResolvedValue({}) });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await postgres?.stop();
  }, 120_000);

  const upsert = async (headers: typeof a, externalUserId: string) =>
    (await app.inject({ method: 'PUT', url: `/v1/users/${externalUserId}`, headers, payload: { email: `${externalUserId}@example.test` } })).json().id as string;
  const send = async (headers: typeof a, userId: string, type = 'note') => {
    const res = await app.inject({ method: 'POST', url: '/v1/notifications', headers, payload: { userId, type, payload: { title: 'x' }, channels: ['email'] } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const erase = (headers: typeof a, externalUserId: string) => app.inject({ method: 'DELETE', url: `/v1/users/${encodeURIComponent(externalUserId)}`, headers });
  const count = async (table: 'users' | 'notifications' | 'delivery_attempts' | 'preferences', where = '') =>
    Number((await pool.query(`select count(*) from ${table} ${where}`)).rows[0].count);

  it('removes the user and everything held about them, and nothing else', async () => {
    const dana = await upsert(a, 'dana');
    const eli = await upsert(a, 'eli');
    const danaNote = await send(a, dana);
    const eliNote = await send(a, eli);
    await processNotification(db, channel, danaNote); // leaves a delivery attempt behind
    await app.inject({ method: 'PUT', url: '/v1/users/dana/preferences', headers: a, payload: { preferences: [{ channel: 'email', type: 'promo', enabled: false }] } });
    await app.inject({ method: 'PUT', url: '/v1/users/eli/preferences', headers: a, payload: { preferences: [{ channel: 'email', type: 'promo', enabled: false }] } });
    expect(await count('delivery_attempts', `where notification_id = '${danaNote}'`)).toBe(1);

    expect((await erase(a, 'dana')).statusCode).toBe(204);

    expect(await db.select().from(users).where(eq(users.id, dana))).toEqual([]);
    expect(await count('notifications', `where user_id = '${dana}'`)).toBe(0);
    expect(await count('delivery_attempts', `where notification_id = '${danaNote}'`)).toBe(0);
    expect(await count('preferences', `where user_id = '${dana}'`)).toBe(0);
    // Eli, in the same tenant, is untouched.
    expect(await db.select().from(users).where(eq(users.id, eli))).toHaveLength(1);
    expect(await count('notifications', `where id = '${eliNote}'`)).toBe(1);
    expect(await count('preferences', `where user_id = '${eli}'`)).toBe(1);
  });

  it('answers 204 again when repeated, and for a user that never existed', async () => {
    await upsert(a, 'fay');
    expect((await erase(a, 'fay')).statusCode).toBe(204);
    expect((await erase(a, 'fay')).statusCode).toBe(204);
    expect((await erase(a, 'never-registered')).statusCode).toBe(204);
  });

  it('only ever erases within the calling tenant', async () => {
    const gus = await upsert(a, 'gus');
    const note = await send(a, gus);
    expect((await erase(b, 'gus')).statusCode).toBe(204); // tenant B has no such user, so nothing happens
    expect(await db.select().from(users).where(eq(users.id, gus))).toHaveLength(1);
    expect(await count('notifications', `where id = '${note}'`)).toBe(1);

    // The same external id in two tenants is two different people.
    const hana = await upsert(a, 'hana');
    const hanaB = await upsert(b, 'hana');
    await erase(a, 'hana');
    expect(await db.select().from(users).where(eq(users.id, hana))).toEqual([]);
    expect(await db.select().from(users).where(eq(users.id, hanaB))).toHaveLength(1);
  });

  it('requires an API key', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/users/dana' });
    expect(res.statusCode).toBe(401);
  });

  it('copes with ids that need URL-encoding', async () => {
    const odd = 'a/b c@d';
    const id = await upsert(a, encodeURIComponent(odd));
    expect((await erase(a, odd)).statusCode).toBe(204);
    expect(await db.select().from(users).where(eq(users.id, id))).toEqual([]);
  });

  it('lets a job that was already queued find nothing and stop, without sending', async () => {
    const ivy = await upsert(a, 'ivy');
    const note = await send(a, ivy);
    await erase(a, 'ivy');
    vi.mocked(channel.send).mockClear();
    await expect(processNotification(db, channel, note)).resolves.toBeUndefined();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('lets the same external id register again afterwards as a fresh user with no history', async () => {
    const first = await upsert(a, 'jo');
    await send(a, first);
    await erase(a, 'jo');
    const second = await upsert(a, 'jo');
    expect(second).not.toBe(first);
    expect(await count('notifications', `where user_id = '${second}'`)).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/v1/users/jo/inbox', headers: a })).json().notifications).toEqual([]);
  });

  it('keeps digest members consistent: erasing the user removes leaders and members together', async () => {
    const kim = await upsert(a, 'kim');
    const lead = await send(a, kim);
    const member = await send(a, kim);
    await pool.query('update notifications set digest_parent_id = $1, status = $2 where id = $3', [lead, 'batched', member]);
    expect((await erase(a, 'kim')).statusCode).toBe(204);
    expect(await count('notifications', `where id in ('${lead}', '${member}')`)).toBe(0);
  });

  it('does not touch the tenant itself or its API keys', async () => {
    await erase(a, 'dana');
    expect(await db.select().from(tenants).where(eq(tenants.id, tenantA))).toHaveLength(1);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantA))).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/v1/stats', headers: a })).statusCode).toBe(200);
  });
});
