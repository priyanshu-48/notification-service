import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import WebSocket from 'ws';
import * as schema from '../src/db/schema.js';
import { apiKeys, tenants, users } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/auth/key.js';
import { notificationQueueName } from '../src/queue.js';
import { MockEmailChannel } from '../src/mock-email-channel.js';
import { createRedisPublisher } from '../src/realtime.js';
import { processNotification } from '../src/worker-service.js';

const secret = 's'.repeat(32);
const key = 'ntf_live_phase3';
type Msg = { type: string; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('real-time stream and offline inbox', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let pool: Pool;
  let queue: Queue;
  let worker: Worker;
  let redisOptions: { host: string; port: number };
  const apps: Array<ReturnType<typeof buildApp>> = [];
  const ports: number[] = [];
  const auth = { authorization: `Bearer ${key}` };

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    const [tenant] = await db.insert(tenants).values({ name: 'T' }).returning();
    await db.insert(apiKeys).values({ tenantId: tenant!.id, keyHash: hashApiKey(key) });
    await db.insert(users).values({ tenantId: tenant!.id, externalUserId: 'alice' });

    redisOptions = { host: redis.getHost(), port: redis.getMappedPort(6379) };
    queue = new Queue(notificationQueueName, { connection: { ...redisOptions, maxRetriesPerRequest: null } });
    const workerConnection = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const publisher = createRedisPublisher(workerConnection);
    worker = new Worker(notificationQueueName, async (job) => {
      await processNotification(db, new MockEmailChannel(), job.data.notificationId as string, { publisher });
    }, { connection: workerConnection.duplicate() });

    // Two independent gateway instances sharing only Postgres and Redis.
    for (let i = 0; i < 2; i++) {
      const app = buildApp(db, queue, { stream: { secret, subscriber: new Redis(redisOptions) } });
      await app.listen({ port: 0, host: '127.0.0.1' });
      apps.push(app);
      ports.push((app.server.address() as { port: number }).port);
    }
    await worker.waitUntilReady();
  }, 120_000);

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await worker?.close();
    await queue?.close();
    await pool?.end();
    await redis?.stop();
    await postgres?.stop();
  }, 120_000);

  const mintToken = async () => (await apps[0]!.inject({ method: 'POST', url: '/v1/users/alice/stream-token', headers: auth })).json().token as string;
  const send = async (title: string) => {
    const user = (await apps[0]!.inject({ method: 'GET', url: '/v1/users/alice/inbox', headers: auth })).statusCode;
    expect(user).toBe(200);
    const [{ id }] = await pool.query('select id from users where external_user_id = $1', ['alice']).then((r) => r.rows);
    const res = await apps[0]!.inject({ method: 'POST', url: '/v1/notifications', headers: auth, payload: { userId: id, type: 'note', payload: { title }, channels: ['in_app'] } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  function connect(port: number, token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=${encodeURIComponent(token)}`);
    const messages: Msg[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    const opened = new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('close', (code) => reject(new Error(`closed ${code}`))); });
    return { ws, messages, opened };
  }
  async function until(check: () => boolean) {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for stream message');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('rejects a bad token, pushes live across gateway instances, replays the inbox after offline, and tracks read', async () => {
    // The upgrade succeeds, then the server closes the socket with 4401.
    const bad = new WebSocket(`ws://127.0.0.1:${ports[0]}/stream?token=nope`);
    const code = await new Promise((resolve) => bad.once('close', resolve));
    expect(code).toBe(4401);

    // Connect to instance B; the notification is created through instance A and delivered by the worker via Redis pub/sub.
    const token = await mintToken();
    const live = connect(ports[1]!, token);
    await live.opened;
    await until(() => live.messages.some((m) => m.type === 'inbox'));
    const firstId = await send('first');
    await until(() => live.messages.some((m) => m.type === 'notification' && m.notification.id === firstId));
    live.ws.close();

    // Offline: sent while no socket is connected anywhere.
    const missedId = await send('missed');
    await new Promise((r) => setTimeout(r, 300));

    const back = connect(ports[0]!, token);
    await back.opened;
    await until(() => back.messages.some((m) => m.type === 'inbox'));
    const inbox = back.messages.find((m) => m.type === 'inbox')!.notifications as Array<{ id: string; readAt: string | null }>;
    expect(inbox.map((n) => n.id)).toEqual([missedId, firstId]);
    expect(inbox.every((n) => n.readAt === null)).toBe(true);

    back.ws.send(JSON.stringify({ type: 'read', id: missedId }));
    await until(() => back.messages.some((m) => m.type === 'read' && m.id === missedId && m.ok === true));
    back.ws.send(JSON.stringify({ type: 'read', id: missedId })); // idempotent
    back.ws.close();

    const rest = await apps[1]!.inject({ method: 'GET', url: '/v1/users/alice/inbox', headers: auth });
    const byId = new Map((rest.json().notifications as Array<{ id: string; readAt: string | null }>).map((n) => [n.id, n]));
    expect(byId.get(missedId)!.readAt).not.toBeNull();
    expect(byId.get(firstId)!.readAt).toBeNull();
  }, 30_000);
});
