import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import * as schema from '../src/db/schema.js';
import { apiKeys, tenants } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/auth/key.js';
import { notificationQueueName } from '../src/queue.js';
import { MockEmailChannel } from '../src/mock-email-channel.js';
import { createRedisPublisher } from '../src/realtime.js';
import { processNotification } from '../src/worker-service.js';
import { NotificationApiError, NotificationClient, NotificationStream, type InboxItem } from '../sdk/src/index.js';

// The SDK against the real service over real HTTP and a real WebSocket: nothing is stubbed.
describe('SDK against the running service', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let pool: Pool;
  let queue: Queue;
  let worker: Worker;
  let app: ReturnType<typeof buildApp>;
  let client: NotificationClient;
  let origin: string;
  const email = new MockEmailChannel();

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    const [tenant] = await db.insert(tenants).values({ name: 'SDK' }).returning();
    await db.insert(apiKeys).values({ tenantId: tenant!.id, keyHash: hashApiKey('ntf_live_sdk') });

    const opts = { host: redis.getHost(), port: redis.getMappedPort(6379) };
    queue = new Queue(notificationQueueName, { connection: { ...opts, maxRetriesPerRequest: null } });
    const workerRedis = new Redis({ ...opts, maxRetriesPerRequest: null });
    const publisher = createRedisPublisher(workerRedis);
    worker = new Worker(notificationQueueName, async (job) => {
      await processNotification(db, email, job.data.notificationId as string, { publisher });
    }, { connection: workerRedis.duplicate() });
    app = buildApp(db, queue, { stream: { secret: 's'.repeat(32), subscriber: new Redis(opts) } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    origin = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
    client = new NotificationClient({ baseUrl: `http://${origin}`, apiKey: 'ntf_live_sdk' });
    await worker.waitUntilReady();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await worker?.close();
    await queue?.close();
    await pool?.end();
    await redis?.stop();
    await postgres?.stop();
  }, 120_000);

  async function until(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('covers the integration flow end to end', async () => {
    // Users, templates and preferences, addressed by the caller's own user id.
    const user = await client.upsertUser('dana', { email: 'dana@example.test' });
    expect(user.externalUserId).toBe('dana');
    await client.createTemplate({ name: 'limit', subject: 'Limit: {{site}}', body: '<p>{{site}} {{minutes}}m</p>', variables: ['site', 'minutes'] });
    expect((await client.listTemplates()).map((t) => t.name)).toEqual(['limit']);
    await client.setPreferences('dana', [{ channel: 'email', type: 'newsletter', enabled: false }]);
    expect(await client.getPreferences('dana')).toEqual([{ channel: 'email', type: 'newsletter', enabled: false, quietHours: null }]);

    // Live stream: backlog replay is empty, then a push arrives.
    const stream = new NotificationStream({
      url: `ws://${origin}/stream`, getToken: async () => (await client.createStreamToken('dana')).token,
    });
    const backlog: InboxItem[][] = []; const live: InboxItem[] = [];
    stream.on('inbox', (items) => backlog.push(items));
    stream.on('notification', (n) => live.push(n));
    stream.connect();
    await until(() => backlog.length === 1);
    expect(backlog[0]).toEqual([]);

    // Send by external id; templated email plus in-app. Same idempotency key twice is one notification.
    const key = 'limit:dana:2026-01-01';
    const first = await client.send({ externalUserId: 'dana', type: 'limit', payload: { title: 'YouTube: 40 min' }, channels: ['email', 'in_app'], templateName: 'limit', variables: { site: 'YouTube', minutes: 40 } }, { idempotencyKey: key });
    const again = await client.send({ externalUserId: 'dana', type: 'limit', payload: { title: 'YouTube: 40 min' }, channels: ['email', 'in_app'], templateName: 'limit', variables: { site: 'YouTube', minutes: 40 } }, { idempotencyKey: key });
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ id: first.id, replayed: true });

    await until(() => live.length === 1);
    expect(live[0]).toMatchObject({ id: first.id, payload: { title: 'YouTube: 40 min' }, readAt: null });
    await until(async () => (await client.getNotification(first.id)).status === 'delivered');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: 'dana@example.test', subject: 'Limit: YouTube' });
    const detail = await client.getNotification(first.id);
    expect(detail.deliveryAttempts.map((a) => `${a.channel}:${a.status}`).sort()).toEqual(['in_app:sent', 'mock-email:sent']);

    // Read state, both directions.
    expect(await stream.markRead(first.id)).toBe(true);
    expect((await client.getInbox('dana'))[0]).toMatchObject({ id: first.id, readAt: expect.any(String) });
    stream.close();

    // The opted-out type is suppressed; unknown users and bad input surface as typed errors.
    const news = await client.send({ externalUserId: 'dana', type: 'newsletter', payload: {} });
    await until(async () => (await client.getNotification(news.id)).status === 'suppressed');
    const missing = await client.send({ externalUserId: 'ghost', type: 't', payload: {} }).catch((e) => e);
    expect(missing).toBeInstanceOf(NotificationApiError);
    expect(missing).toMatchObject({ status: 422, code: 'USER_NOT_FOUND' });
    await expect(client.send({ type: 't', payload: {} } as never)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });

    expect((await client.listNotifications({ status: 'delivered' })).notifications.some((n) => n.id === first.id)).toBe(true);
    expect((await client.getStats(1)).notifications.delivered).toBeGreaterThanOrEqual(1);
    expect(await client.listDeadLetters()).toEqual([]);
  }, 60_000);
});
