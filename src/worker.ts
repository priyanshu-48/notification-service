import 'dotenv/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createDatabase } from './db/client.js';
import { createEmailChannel } from './resend-email-channel.js';
import { notificationQueueName } from './queue.js';
import { processNotification } from './worker-service.js';

const { db, pool } = createDatabase();
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const channel = createEmailChannel();
const worker = new Worker(notificationQueueName, async (job) => {
  if (typeof job.data.notificationId !== 'string') throw new Error('Invalid notification job');
  await processNotification(db, channel, job.data.notificationId);
}, { connection });

worker.on('failed', (job, error) => console.error('Notification job failed', { jobId: job?.id, error }));
worker.on('error', (error) => console.error('Notification worker error', error));
console.info('Notification worker started');

async function shutdown() {
  await worker.close();
  await connection.quit();
  await pool.end();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
