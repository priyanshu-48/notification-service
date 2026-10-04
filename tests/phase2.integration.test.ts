import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import * as schema from '../src/db/schema.js';
import { apiKeys, deliveryAttempts, notifications, templates, tenants, users } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/auth/key.js';
import { notificationQueueName } from '../src/queue.js';
import { MockEmailChannel } from '../src/mock-email-channel.js';
import { processNotification } from '../src/worker-service.js';

describe('API to queue to worker integration', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let queue: Queue;
  let worker: Worker;
  let app: ReturnType<typeof buildApp>;
  let channel: MockEmailChannel;
  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;
  const keyA = 'ntf_live_tenant_a';
  const keyB = 'ntf_live_tenant_b';

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });

    const [tenantA] = await db.insert(tenants).values({ name: 'Tenant A' }).returning();
    const [tenantB] = await db.insert(tenants).values({ name: 'Tenant B' }).returning();
    tenantAId = tenantA!.id;
    tenantBId = tenantB!.id;
    await db.insert(apiKeys).values([
      { tenantId: tenantAId, keyHash: hashApiKey(keyA) },
      { tenantId: tenantBId, keyHash: hashApiKey(keyB) },
    ]);
    const [userA] = await db.insert(users).values({ tenantId: tenantAId, externalUserId: 'user-a', email: 'a@example.test' }).returning();
    userAId = userA!.id;
    await db.insert(templates).values({ tenantId: tenantAId, name: 'welcome', subject: 'Hi {{name}}', body: '<p>Hello {{name}}</p>', variables: ['name'] });

    const connectionOptions = { host: redis.getHost(), port: redis.getMappedPort(6379), maxRetriesPerRequest: null };
    queue = new Queue(notificationQueueName, { connection: connectionOptions });
    channel = new MockEmailChannel();
    worker = new Worker(notificationQueueName, async (job) => {
      await processNotification(db, channel, job.data.notificationId as string);
    }, { connection: new Redis(connectionOptions) });
    app = buildApp(db, queue);
    await worker.waitUntilReady();
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await worker?.close();
    await queue?.close();
    await pool?.end();
    await redis?.stop();
    await postgres?.stop();
  }, 120_000);

  it('keeps templates and users tenant-scoped and delivers through the mock channel', async () => {
    const upsertedUser = await app.inject({ method: 'PUT', url: '/v1/users/user-b', headers: { authorization: `Bearer ${keyB}` }, payload: { email: 'b@example.test' } });
    expect(upsertedUser.statusCode).toBe(200);

    const otherTenantTemplates = await app.inject({ method: 'GET', url: '/v1/templates', headers: { authorization: `Bearer ${keyB}` } });
    expect(otherTenantTemplates.statusCode).toBe(200);
    expect(otherTenantTemplates.json().templates).toEqual([]);

    const crossTenantSend = await app.inject({ method: 'POST', url: '/v1/notifications', headers: { authorization: `Bearer ${keyB}` }, payload: {
      userId: userAId, type: 'welcome', payload: {},
    } });
    expect(crossTenantSend.statusCode).toBe(422);

    const missingVariables = await app.inject({ method: 'POST', url: '/v1/notifications', headers: { authorization: `Bearer ${keyA}` }, payload: {
      userId: userAId, type: 'welcome', payload: {}, templateName: 'welcome', variables: {},
    } });
    expect(missingVariables.statusCode).toBe(422);

    const created = await app.inject({ method: 'POST', url: '/v1/notifications', headers: { authorization: `Bearer ${keyA}` }, payload: {
      userId: userAId, type: 'welcome', payload: {}, templateName: 'welcome', variables: { name: '<Sam & Co>' },
    } });
    expect(created.statusCode).toBe(201);
    const notificationId = created.json().id as string;

    await viWaitFor(async () => {
      const [row] = await db.select({ status: notifications.status }).from(notifications).where(eq(notifications.id, notificationId));
      expect(row?.status).toBe('delivered');
    });
    expect(channel.sent).toEqual([{ to: 'a@example.test', subject: 'Hi <Sam & Co>', html: '<p>Hello &lt;Sam &amp; Co&gt;</p>' }]);
    const attempts = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.notificationId, notificationId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('sent');
    const [saved] = await db.select({ tenantId: notifications.tenantId }).from(notifications).where(eq(notifications.id, notificationId));
    expect(saved?.tenantId).toBe(tenantAId);
    expect(tenantBId).not.toBe(tenantAId);

    await processNotification(db, channel, notificationId);
    const duplicateAttempts = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.notificationId, notificationId));
    expect(duplicateAttempts).toHaveLength(1);

    const [failureNotification] = await db.insert(notifications).values({ tenantId: tenantAId, userId: userAId, type: 'failure-test', payload: {} }).returning();
    const failingChannel = { name: 'mock-failure', send: async () => { throw new Error('provider unavailable'); } };
    await expect(processNotification(db, failingChannel, failureNotification!.id)).resolves.toBeUndefined();
    const [failedRow] = await db.select({ status: notifications.status }).from(notifications).where(eq(notifications.id, failureNotification!.id));
    expect(failedRow?.status).toBe('failed');
    const failedAttempts = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.notificationId, failureNotification!.id));
    expect(failedAttempts).toHaveLength(1);
    expect(failedAttempts[0]?.status).toBe('failed');

    const [nextNotification] = await db.insert(notifications).values({ tenantId: tenantAId, userId: userAId, type: 'after-failure', payload: {} }).returning();
    await expect(processNotification(db, channel, nextNotification!.id)).resolves.toBeUndefined();
  }, 30_000);
});

async function viWaitFor(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}
