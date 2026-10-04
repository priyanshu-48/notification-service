// Standalone worker process for the chaos test: it is killed mid-send, so it must be a real OS process.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createDatabase } from '../src/db/client.js';
import { notificationQueueName } from '../src/queue.js';
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
new Worker(notificationQueueName, async (job) => {
  await processNotification(db, channel, job.data.notificationId as string);
}, {
  connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
  concurrency: 5, lockDuration: 2000, stalledInterval: 1000, maxStalledCount: 3,
});
console.info('chaos worker ready');
