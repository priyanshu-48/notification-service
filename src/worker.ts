import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createDatabase } from './db/client.js';
import { createEmailChannel } from './resend-email-channel.js';
import { notificationQueueName } from './queue.js';
import { sweepStuckNotifications } from './sweeper.js';
import { createRedisPublisher } from './realtime.js';
import { processNotification } from './worker-service.js';

const { db, pool } = createDatabase();
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const channel = createEmailChannel();
const publisher = createRedisPublisher(connection);
const worker = new Worker(notificationQueueName, async (job) => {
  if (typeof job.data.notificationId !== 'string') throw new Error('Invalid notification job');
  await processNotification(db, channel, job.data.notificationId, publisher);
}, { connection, maxStalledCount: 3 });
const queue = new Queue(notificationQueueName, { connection });

// Every worker sweeps; duplicate enqueues collapse on jobId.
const sweeper = setInterval(() => {
  sweepStuckNotifications(db, queue).then((n) => n && console.info(`Sweeper re-enqueued ${n} stuck notifications`), (error) => console.error('Sweeper failed', error));
}, 30_000);

worker.on('failed', (job, error) => console.error('Notification job failed', { jobId: job?.id, error }));
worker.on('error', (error) => console.error('Notification worker error', error));
console.info('Notification worker started');

// worker.close() waits for in-flight jobs, so a deploy or SIGTERM never abandons a half-sent notification.
async function shutdown() {
  clearInterval(sweeper);
  await worker.close();
  await queue.close();
  await connection.quit();
  await pool.end();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
