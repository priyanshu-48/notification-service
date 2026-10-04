import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import * as schema from '../src/db/schema.js';
import { apiKeys, deliveryAttempts, notifications, tenants, users } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/auth/key.js';
import { enqueueNotification, notificationQueueName } from '../src/queue.js';
import { PermanentDeliveryError, type Channel, type EmailMessage } from '../src/channel.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { sweepStuckNotifications } from '../src/sweeper.js';
import { processNotification } from '../src/worker-service.js';

const fastRetry = { attempts: 5, backoff: { type: 'exponential', delay: 20, jitter: 0.5 } };

describe('reliability: retries, dead letters, idempotency, rate limiting, recovery', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let queue: Queue;
  let worker: Worker;
  let app: ReturnType<typeof buildApp>;
  let limitedApp: ReturnType<typeof buildApp>;
  let tenantId: string;
  let userId: string;
  const sent: EmailMessage[] = [];
  let behaviour: (message: EmailMessage) => Promise<void> = async () => undefined;
  const channel: Channel = { name: 'test-email', send: async (m) => { await behaviour(m); sent.push(m); } };
  const auth = { authorization: 'Bearer ntf_live_p4_a' };

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    const [a] = await db.insert(tenants).values({ name: 'A' }).returning();
    const [b] = await db.insert(tenants).values({ name: 'B' }).returning();
    tenantId = a!.id;
    await db.insert(apiKeys).values([{ tenantId, keyHash: hashApiKey('ntf_live_p4_a') }, { tenantId: b!.id, keyHash: hashApiKey('ntf_live_p4_b') }]);
    const [u] = await db.insert(users).values({ tenantId, externalUserId: 'u', email: 'u@example.test' }).returning();
    userId = u!.id;

    const opts = { host: redis.getHost(), port: redis.getMappedPort(6379) };
    queue = new Queue(notificationQueueName, { connection: { ...opts, maxRetriesPerRequest: null } });
    worker = new Worker(notificationQueueName, async (job) => {
      await processNotification(db, channel, job.data.notificationId as string);
    }, { connection: new Redis({ ...opts, maxRetriesPerRequest: null }) });
    app = buildApp(db, queue);
    // 1 token/second, burst of 3.
    limitedApp = buildApp(db, queue, { rateLimiter: createRateLimiter(new Redis(opts), { perMinute: 60, burst: 3 }) });
    await worker.waitUntilReady();
    await Promise.all([app.ready(), limitedApp.ready()]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([app?.close(), limitedApp?.close()]);
    await worker?.close();
    await queue?.close();
    await pool?.end();
    await redis?.stop();
    await postgres?.stop();
  }, 120_000);

  const create = async () => (await db.insert(notifications).values({ tenantId, userId, type: 'p4', payload: {} }).returning({ id: notifications.id }))[0]!.id;
  const row = async (id: string) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;
  const attemptsOf = (id: string) => db.select().from(deliveryAttempts).where(eq(deliveryAttempts.notificationId, id));
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('returns the original notification for a repeated Idempotency-Key and rejects a changed body', async () => {
    sent.length = 0;
    behaviour = async () => undefined;
    const request = (payload: object) => app.inject({ method: 'POST', url: '/v1/notifications', headers: { ...auth, 'idempotency-key': 'key-1' }, payload });
    const body = { userId, type: 'idem', payload: { b: 2, a: 1 } };
    const first = await request(body);
    expect(first.statusCode).toBe(201);
    const second = await request({ userId, type: 'idem', payload: { a: 1, b: 2 } }); // same content, different key order
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
    const changed = await request({ ...body, type: 'other' });
    expect(changed.statusCode).toBe(422);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    await until(async () => (await row(first.json().id)).status === 'delivered');
    const third = await request(body); // after delivery: still the original, nothing re-sent
    expect(third.statusCode).toBe(200);
    expect(third.json().status).toBe('delivered');
    expect(sent).toHaveLength(1);
    const count = await pool.query("select count(*)::int as n from notifications where idempotency_key = 'key-1'");
    expect(count.rows[0].n).toBe(1);
  }, 30_000);

  it('retries transient failures with backoff and then delivers', async () => {
    sent.length = 0;
    let calls = 0;
    behaviour = async () => { if (++calls <= 2) throw new Error('provider 503'); };
    const id = await create();
    await enqueueNotification(queue, id, { retry: fastRetry });
    await until(async () => (await row(id)).status === 'delivered');
    const attempts = await attemptsOf(id);
    expect(attempts.map((a) => a.status).sort()).toEqual(['failed', 'failed', 'sent']);
    expect((await row(id)).attempts).toBe(3);
    expect(sent).toHaveLength(1);
  }, 30_000);

  it('dead-letters a permanent failure immediately, lists it, and replays it', async () => {
    behaviour = async () => { throw new PermanentDeliveryError('mailbox does not exist'); };
    const id = await create();
    await enqueueNotification(queue, id, { retry: fastRetry });
    await until(async () => (await row(id)).status === 'failed');
    expect((await row(id)).attempts).toBe(1); // no retries for a permanent error

    const dead = await app.inject({ method: 'GET', url: '/v1/dead-letters', headers: auth });
    expect(dead.json().notifications.map((n: { id: string }) => n.id)).toContain(id);
    const status = await app.inject({ method: 'GET', url: `/v1/notifications/${id}`, headers: auth });
    expect(status.json()).toMatchObject({ status: 'failed', attempts: 1, deliveryAttempts: [{ status: 'failed', error: 'mailbox does not exist' }] });
    const otherTenant = await app.inject({ method: 'POST', url: `/v1/notifications/${id}/replay`, headers: { authorization: 'Bearer ntf_live_p4_b' } });
    expect(otherTenant.statusCode).toBe(404);

    behaviour = async () => undefined;
    const replay = await app.inject({ method: 'POST', url: `/v1/notifications/${id}/replay`, headers: auth });
    expect(replay.statusCode).toBe(202);
    await until(async () => (await row(id)).status === 'delivered');
    const again = await app.inject({ method: 'POST', url: `/v1/notifications/${id}/replay`, headers: auth });
    expect(again.statusCode).toBe(409);
  }, 30_000);

  it('dead-letters after exhausting all attempts', async () => {
    behaviour = async () => { throw new Error('provider down'); };
    const id = await create();
    await enqueueNotification(queue, id, { retry: fastRetry });
    await until(async () => (await row(id)).status === 'failed');
    expect((await row(id)).attempts).toBe(5);
    expect((await attemptsOf(id)).filter((a) => a.status === 'failed')).toHaveLength(5);
  }, 30_000);

  it('recovers a committed-but-never-enqueued notification via the sweeper', async () => {
    sent.length = 0;
    behaviour = async () => undefined;
    const id = await create(); // inserted but no job: what an enqueue failure leaves behind
    await db.update(notifications).set({ updatedAt: sql`now() - interval '5 minutes'` }).where(eq(notifications.id, id));
    expect(await sweepStuckNotifications(db, queue)).toBeGreaterThanOrEqual(1);
    await until(async () => (await row(id)).status === 'delivered');
    expect(sent).toHaveLength(1);
  }, 30_000);

  it('rate limits per tenant with a Retry-After header', async () => {
    const hit = (headers = auth) => limitedApp.inject({ method: 'GET', url: '/v1/dead-letters', headers });
    for (let i = 0; i < 3; i++) expect((await hit()).statusCode).toBe(200);
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect((await hit({ authorization: 'Bearer ntf_live_p4_b' })).statusCode).toBe(200); // another tenant is unaffected
  }, 30_000);
});
