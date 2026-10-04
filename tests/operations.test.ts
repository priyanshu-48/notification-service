import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';

function fakes(overrides: { postgresDown?: boolean; redisDown?: boolean } = {}) {
  const db = {
    execute: overrides.postgresDown ? vi.fn().mockRejectedValue(new Error('down')) : vi.fn().mockResolvedValue([]),
    select: () => ({ from: () => ({ groupBy: async () => [{ status: 'delivered', n: 3 }, { status: 'failed', n: 1 }] }) }),
  } as never;
  const queue = {
    add: vi.fn(),
    getJobCounts: overrides.redisDown ? vi.fn().mockRejectedValue(new Error('down')) : vi.fn().mockResolvedValue({ waiting: 2, active: 1, delayed: 0, failed: 0 }),
  };
  return { db, queue };
}

describe('/ready', () => {
  it('is 200 when Postgres and Redis answer', async () => {
    const { db, queue } = fakes();
    const app = buildApp(db, queue);
    const res = await app.inject({ url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { postgres: true, redis: true } });
    await app.close();
  });

  it.each([[{ postgresDown: true }, { postgres: false, redis: true }], [{ redisDown: true }, { postgres: true, redis: false }]])('is 503 and names the failing dependency (%j)', async (down, checks) => {
    const { db, queue } = fakes(down);
    const app = buildApp(db, queue);
    const res = await app.inject({ url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks });
    await app.close();
  });
});

describe('when a dependency hangs instead of failing', () => {
  it('/ready answers 503 and /metrics still responds', async () => {
    const never = new Promise<never>(() => undefined); // like a dead Redis behind a connection that retries forever
    const { db } = fakes();
    const app = buildApp(db, { add: vi.fn(), getJobCounts: () => never });
    const ready = await app.inject({ url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks).toEqual({ postgres: true, redis: false });
    const metrics = await app.inject({ url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('notifications{status="delivered"} 3');
    await app.close();
  }, 15_000);
});

describe('/metrics', () => {
  it('exposes outcome counts, queue depth and request latency by route pattern', async () => {
    const { db, queue } = fakes();
    const app = buildApp(db, queue);
    await app.inject({ url: '/health' });
    const res = await app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('notifications{status="delivered"} 3');
    expect(res.body).toContain('notifications{status="failed"} 1');
    expect(res.body).toContain('notification_queue_jobs{state="waiting"} 2');
    expect(res.body).toMatch(/http_request_duration_seconds_count\{method="GET",route="\/health",status="200"\} 1/);
    expect(res.body).toContain('process_cpu_user_seconds_total');
    await app.close();
  });

  it('requires the bearer token when one is configured', async () => {
    const { db, queue } = fakes();
    const app = buildApp(db, queue, { metricsToken: 'secret-token' });
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/metrics', headers: { authorization: 'Bearer secret-token' } })).statusCode).toBe(200);
    await app.close();
  });
});
