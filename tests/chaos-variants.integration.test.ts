import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
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

// Variants of tests/chaos.integration.test.ts. Every variant ends with the same assertions as the original: all notifications delivered, one
// provider receipt per notification, exactly one `sent` attempt each. Only the failure injected and the scale change. Each variant gets its own
// Postgres and Redis containers so nothing leaks between them. See docs/evidence/chaos/ for results and what each one does not prove.
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(100);
  }
}
const freePort = () => new Promise<number>((resolve) => {
  const server = createServer().listen(0, () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

interface Harness {
  pool: Pool; queue: Queue; redis: StartedTestContainer; dir: string; children: ChildProcess[];
  worker(env?: Record<string, string>): ChildProcess; killed(child: ChildProcess): Promise<void>;
  seed(total: number): Promise<void>; calls(): number; delivered(): Promise<number>; stop(): Promise<void>;
}

async function harness(opts: { persistRedis?: boolean; fixedRedisPort?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-var-'));
  const postgres: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine').start();
  let redisBuilder = new GenericContainer('redis:7-alpine');
  redisBuilder = opts.persistRedis === false ? redisBuilder.withCommand(['redis-server', '--save', '', '--appendonly', 'no']) : redisBuilder;
  redisBuilder = opts.fixedRedisPort ? redisBuilder.withExposedPorts({ container: 6379, host: await freePort() }) : redisBuilder.withExposedPorts(6379);
  const redis = await redisBuilder.start();
  const pool = new Pool({ connectionString: postgres.getConnectionUri() });
  await migrate(drizzle(pool, { schema }), { migrationsFolder: './drizzle' });
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  const queue = new Queue(notificationQueueName, { connection: { host: redis.getHost(), port: redis.getMappedPort(6379), maxRetriesPerRequest: null } });
  const children: ChildProcess[] = [];
  return {
    pool, queue, redis, dir, children,
    worker(env = {}) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/chaos-worker.ts'], {
        env: { ...process.env, DATABASE_URL: postgres.getConnectionUri(), REDIS_URL: redisUrl, SINK_FILE: join(dir, 'sink.txt'), CALLS_FILE: join(dir, 'calls.txt'), ...env },
        stdio: 'ignore',
      });
      children.push(child);
      return child;
    },
    killed(child) {
      const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      return done;
    },
    async seed(total) {
      const db = drizzle(pool, { schema });
      const [tenant] = await db.insert(tenants).values({ name: 'Chaos' }).returning();
      const [user] = await db.insert(users).values({ tenantId: tenant!.id, externalUserId: 'u', email: 'u@example.test' }).returning();
      const rows = await db.insert(notifications).values(Array.from({ length: total }, (_, i) => ({
        tenantId: tenant!.id, userId: user!.id, type: 'chaos', payload: { n: i },
      }))).returning({ id: notifications.id });
      for (const { id } of rows) await enqueueNotification(queue, id);
    },
    calls: () => lines(join(dir, 'calls.txt')).length,
    delivered: async () => (await pool.query("select count(*)::int as n from notifications where status = 'delivered'")).rows[0].n,
    async stop() {
      children.forEach((c) => c.kill());
      await queue.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await redis.stop().catch(() => undefined);
      await postgres.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The original assertions, unchanged in meaning. `retried` is only demanded where a worker was killed mid-send (a Redis restart does not guarantee a re-send).
async function expectNoLossNoDuplicate(h: Harness, total: number, { retried }: { retried: boolean }) {
  const sink = lines(join(h.dir, 'sink.txt'));
  expect(await h.delivered()).toBe(total);
  expect(new Set(sink).size).toBe(total); // none lost
  expect(sink).toHaveLength(total); // none delivered twice by the provider
  if (retried) expect(h.calls()).toBeGreaterThan(total); // crashed sends really were retried
  const sent = await h.pool.query("select notification_id, count(*)::int as n from delivery_attempts where status = 'sent' group by notification_id");
  expect(sent.rows).toHaveLength(total);
  expect(sent.rows.every((r) => r.n === 1)).toBe(true);
}
// On a timeout, say where the work is stuck instead of only that it is.
async function diagnose(h: Harness) {
  const rows = (await h.pool.query('select status, count(*)::int as n from notifications group by status order by status')).rows;
  const jobs = await h.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed').catch((e) => ({ error: String(e) }));
  return `notifications by status: ${JSON.stringify(rows)}; queue: ${JSON.stringify(jobs)}`;
}
const stranded = async (h: Harness) => (await h.pool.query("select count(*)::int as n from notifications where status = 'sending'")).rows[0].n as number;

describe('worker crash variants', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.stop(); h = undefined; });

  // One worker killed after `killAfterCalls` provider calls; a fresh worker finishes the job.
  it.each([
    { name: '100 in flight', total: 100, killAfterCalls: 3 },
    { name: '500 in flight', total: 500, killAfterCalls: 3 },
    { name: 'killed after the first send', total: 50, killAfterCalls: 1 },
    { name: 'killed after 10 sends (a second wave in flight)', total: 50, killAfterCalls: 10 },
  ])('loses nothing and duplicates nothing: $name', async ({ total, killAfterCalls }) => {
    h = await harness();
    await h.seed(total);
    const a = h.worker({ SEND_DELAY_MS: '1500' });
    await until(() => h!.calls() >= killAfterCalls, 60_000, 'worker A to start sending');
    await h.killed(a);
    expect(await stranded(h)).toBeGreaterThan(0);
    h.worker({ SEND_DELAY_MS: '20' });
    await until(async () => (await h!.delivered()) === total, 150_000, 'all notifications to be delivered');
    await expectNoLossNoDuplicate(h, total, { retried: true });
  }, 240_000);

  it('two workers run together and one is killed: the survivor finishes everything', async () => {
    h = await harness();
    await h.seed(50);
    const a = h.worker({ SEND_DELAY_MS: '1500' });
    h.worker({ SEND_DELAY_MS: '300' });
    await until(() => h!.calls() >= 6, 60_000, 'both workers to start sending');
    await h.killed(a);
    await until(async () => (await h!.delivered()) === 50, 150_000, 'the surviving worker to deliver everything');
    await expectNoLossNoDuplicate(h, 50, { retried: true });
  }, 240_000);

  it('every worker is killed at once, then a new one starts', async () => {
    h = await harness();
    await h.seed(50);
    const a = h.worker({ SEND_DELAY_MS: '1500' });
    const b = h.worker({ SEND_DELAY_MS: '1500' });
    await until(() => h!.calls() >= 6, 60_000, 'both workers to start sending');
    await Promise.all([h.killed(a), h.killed(b)]);
    expect(await stranded(h)).toBeGreaterThan(0);
    h.worker({ SEND_DELAY_MS: '20' });
    await until(async () => (await h!.delivered()) === 50, 150_000, 'a new worker to deliver everything');
    await expectNoLossNoDuplicate(h, 50, { retried: true });
  }, 240_000);

  // Same scenario as the original test but with the timings src/worker-runtime.ts ships (30 s lock, 30 s stall check), so recovery is the real, slower one.
  // Opt-in (about 65 s): CHAOS_SLOW=1 npx vitest run tests/chaos-variants.integration.test.ts
  it.skipIf(!process.env.CHAOS_SLOW)('with production timings (BullMQ default lock and stall intervals, sweeper 30 s / 60 s)', async () => {
    h = await harness();
    await h.seed(20);
    const a = h.worker({ SEND_DELAY_MS: '1500', PROD_TIMING: '1' });
    await until(() => h!.calls() >= 3, 60_000, 'worker A to start sending');
    await h.killed(a);
    expect(await stranded(h)).toBeGreaterThan(0);
    const killedAt = Date.now();
    h.worker({ SEND_DELAY_MS: '20', PROD_TIMING: '1' });
    await until(async () => (await h!.delivered()) === 20, 200_000, 'recovery with production timings');
    console.info(`production-timing recovery took ${Math.round((Date.now() - killedAt) / 1000)} s after the kill`);
    await expectNoLossNoDuplicate(h, 20, { retried: true });
  }, 300_000);
});

describe('Redis restart variants (no worker is killed)', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.stop(); h = undefined; });

  it('Redis restarts gracefully (data saved to disk): workers reconnect and finish', async () => {
    h = await harness({ fixedRedisPort: true });
    await h.seed(100);
    h.worker({ SEND_DELAY_MS: '300' });
    await until(async () => (await h!.delivered()) >= 10, 60_000, 'delivery to be under way');
    await h.redis.restart({ timeout: 10_000 }); // graceful: Redis saves its data on SIGTERM. restart() defaults to timeout 0, which kills it with nothing saved.
    await until(async () => (await h!.delivered()) === 100, 180_000, 'delivery to finish after the restart').catch(async (e) => { throw new Error(`${e.message}; ${await diagnose(h!)}`); });
    await expectNoLossNoDuplicate(h, 100, { retried: false });
  }, 300_000);

  it('Redis restarts and LOSES all its data: the sweeper rebuilds the queue from Postgres', async () => {
    h = await harness({ fixedRedisPort: true, persistRedis: false });
    await h.seed(100);
    // Shortened sweeper (every 2 s, rows idle for 5 s) so the test is quick; production uses 30 s and 60 s.
    h.worker({ SEND_DELAY_MS: '300', SWEEP_MS: '2000', SWEEP_OLDER_MS: '5000' });
    await until(async () => (await h!.delivered()) >= 10, 60_000, 'delivery to be under way');
    await h.redis.restart();
    await until(async () => (await h!.delivered()) === 100, 180_000, 'the sweeper to recover the lost queue');
    await expectNoLossNoDuplicate(h, 100, { retried: false });
  }, 300_000);
});
