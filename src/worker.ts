import 'dotenv/config';
import { createDatabase } from './db/client.js';
import { startWorker } from './worker-runtime.js';

const { db, pool } = createDatabase();
const worker = startWorker(db, {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
});

async function shutdown() {
  await worker.close();
  await pool.end();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
