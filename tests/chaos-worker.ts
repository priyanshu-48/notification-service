// Standalone worker process for the chaos test: it is killed mid-send, so it must be a real OS process.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createDatabase } from '../src/db/client.js';
import { notificationQueueName } from '../src/queue.js';
import { sweepStuckNotifications } from '../src/sweeper.js';
import { processNotification } from '../src/worker-service.js';
import type { Channel, EmailMessage } from '../src/channel.js';

const sink = process.env.SINK_FILE!;
const calls = process.env.CALLS_FILE!;
const delay = Number(process.env.SEND_DELAY_MS ?? 0);

// Behaves like a provider that honours Idempotency-Key: the first call with a key is "delivered", repeats are ignored.
// It accepts the message first and acknowledges slowly, so a kill during the sleep means the provider got it but we never recorded it.
const channel: Channel = {
  name: 'sink',
  async send(message: EmailMessage) {
    const key = message.idempotencyKey!;
    appendFileSync(calls, `${key}\n`);
    const seen = existsSync(sink) ? readFileSync(sink, 'utf8').split('\n') : [];
    if (!seen.includes(key)) appendFileSync(sink, `${key}\n`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  },
};

const { db } = createDatabase();
// Defaults keep the original chaos test unchanged: short lock/stall timings, concurrency 5, no sweeper.
// PROD_TIMING=1 uses what src/worker-runtime.ts ships (BullMQ defaults: 30 s lock and stall check, concurrency 10, sweeper every 30 s for rows older than 60 s).
// SWEEP_MS / SWEEP_OLDER_MS turn the sweeper on with other values (the Redis-loss variants need it).
const prod = process.env.PROD_TIMING === '1';
const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
new Worker(notificationQueueName, async (job) => {
  await processNotification(db, channel, job.data.notificationId as string);
}, prod
  ? { connection, concurrency: 10, maxStalledCount: 3 }
  : { connection, concurrency: Number(process.env.CONCURRENCY ?? 5), lockDuration: 2000, stalledInterval: 1000, maxStalledCount: 3 });
const sweepMs = prod ? 30_000 : Number(process.env.SWEEP_MS ?? 0);
if (sweepMs) {
  const queue = new Queue(notificationQueueName, { connection });
  const olderThanMs = prod ? 60_000 : Number(process.env.SWEEP_OLDER_MS ?? 5000);
  setInterval(() => { sweepStuckNotifications(db, queue, olderThanMs).catch((error) => console.error('sweep failed', error)); }, sweepMs);
}
console.info('chaos worker ready');
