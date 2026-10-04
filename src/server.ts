import 'dotenv/config';
import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';
import { createNotificationQueue } from './queue.js';
import { Redis } from 'ioredis';
import { createRateLimiter } from './rate-limit.js';
import { startWorker } from './worker-runtime.js';

const { db, pool } = createDatabase();
const { queue, connection } = createNotificationQueue();
const secret = process.env.STREAM_TOKEN_SECRET;
if (!secret || secret.length < 32) throw new Error('STREAM_TOKEN_SECRET must be set to at least 32 characters');
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
// pub/sub needs its own connection: a subscribed Redis client cannot issue other commands
const subscriber = new Redis(redisUrl);
// Dedicated fail-fast connection: with the queue connection's unlimited retries, a Redis outage would hang requests instead of failing open.
const limiterRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
const rateLimiter = createRateLimiter(limiterRedis, {
  perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600),
  burst: Number(process.env.RATE_LIMIT_BURST ?? 100),
});
const app = buildApp(db, queue, { stream: { secret, subscriber }, rateLimiter, ...(process.env.METRICS_TOKEN ? { metricsToken: process.env.METRICS_TOKEN } : {}) });
// Single-process mode for hosts where a separate worker costs extra (e.g. Render's free tier). Prefer a separate worker when you can.
const worker = process.env.RUN_WORKER === 'true'
  ? startWorker(db, { redisUrl, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10) })
  : undefined;
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

async function closeAll() {
  await worker?.close();
  await queue.close();
  await connection.quit();
  await limiterRedis.quit();
  await pool.end();
}

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await closeAll();
  process.exitCode = 1;
}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'Shutting down API');
  await app.close();
  await closeAll();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
