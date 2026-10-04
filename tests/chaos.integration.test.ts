import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import * as schema from '../src/db/schema.js';
import { notifications, tenants, users } from '../src/db/schema.js';
import { enqueueNotification, notificationQueueName } from '../src/queue.js';

const total = 20;
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(100);
  }
}

describe('worker crash mid-send', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let pool: Pool;
  let queue: Queue;
  let dir: string;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chaos-'));
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    await migrate(drizzle(pool, { schema }), { migrationsFolder: './drizzle' });
  }, 120_000);

  afterAll(async () => {
    children.forEach((c) => c.kill());
    await queue?.close();
    await pool?.end();
    await redis?.stop();
    await postgres?.stop();
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  const startWorker = (sendDelayMs: number) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/chaos-worker.ts'], {
      env: {
        ...process.env, DATABASE_URL: postgres.getConnectionUri(), REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
        SINK_FILE: join(dir, 'sink.txt'), CALLS_FILE: join(dir, 'calls.txt'), SEND_DELAY_MS: String(sendDelayMs),
      },
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  };

  it('loses no notification and sends none twice when a worker is killed', async () => {
    const db = drizzle(pool, { schema });
    const [tenant] = await db.insert(tenants).values({ name: 'Chaos' }).returning();
    const [user] = await db.insert(users).values({ tenantId: tenant!.id, externalUserId: 'u', email: 'u@example.test' }).returning();
    queue = new Queue(notificationQueueName, { connection: { host: redis.getHost(), port: redis.getMappedPort(6379), maxRetriesPerRequest: null } });
    const rows = await db.insert(notifications).values(Array.from({ length: total }, (_, i) => ({
      tenantId: tenant!.id, userId: user!.id, type: 'chaos', payload: { n: i },
    }))).returning({ id: notifications.id });
    for (const { id } of rows) await enqueueNotification(queue, id);

    // Worker A takes 1.5s to acknowledge each send; kill it once several sends are in flight.
    const a = startWorker(1500);
    const killed = new Promise((resolve) => a.once('exit', resolve));
    await until(() => lines(join(dir, 'calls.txt')).length >= 3, 30_000, 'worker A to start sending');
    a.kill('SIGKILL');
    await killed;
    const stranded = await pool.query("select count(*)::int as n from notifications where status = 'sending'");
    expect(stranded.rows[0].n).toBeGreaterThan(0); // the crash really left work half-done

    startWorker(20);
    await until(async () => (await pool.query("select count(*)::int as n from notifications where status = 'delivered'")).rows[0].n === total, 60_000, 'all notifications to be delivered');

    const sink = lines(join(dir, 'sink.txt'));
    expect(new Set(sink).size).toBe(total); // none lost
    expect(sink).toHaveLength(total); // none delivered twice by the provider
    expect(lines(join(dir, 'calls.txt')).length).toBeGreaterThan(total); // crashed sends really were retried
    const sent = await pool.query("select notification_id, count(*)::int as n from delivery_attempts where status = 'sent' group by notification_id");
    expect(sent.rows).toHaveLength(total);
    expect(sent.rows.every((r) => r.n === 1)).toBe(true);
  }, 120_000);
});
