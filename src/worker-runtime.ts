import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { createEmailChannel } from './resend-email-channel.js';
import { notificationQueueName } from './queue.js';
import { sweepStuckNotifications } from './sweeper.js';
import { createRedisPublisher } from './realtime.js';
import { createJobHandler } from './worker-service.js';

// Shared by the standalone worker process and by the API when RUN_WORKER=true (single-process deployments such as Render's free tier).
export function startWorker(db: NodePgDatabase<typeof schema>, { redisUrl, concurrency }: { redisUrl: string; concurrency: number }) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker(notificationQueueName, createJobHandler(db, createEmailChannel(), createRedisPublisher(connection)), {
    connection, concurrency, maxStalledCount: 3,
  });
  const queue = new Queue(notificationQueueName, { connection });

  // Every worker sweeps; duplicate enqueues collapse on jobId.
  const sweeper = setInterval(() => {
    sweepStuckNotifications(db, queue).then((n) => n && console.info(`Sweeper re-enqueued ${n} stuck notifications`), (error) => console.error('Sweeper failed', error));
  }, 30_000);

  worker.on('failed', (job, error) => console.error('Notification job failed', { jobId: job?.id, error }));
  worker.on('error', (error) => console.error('Notification worker error', error));
  console.info(`Notification worker started (concurrency ${concurrency})`);

  return {
    // worker.close() waits for in-flight jobs, so a deploy or SIGTERM never abandons a half-sent notification.
    async close() {
      clearInterval(sweeper);
      await worker.close();
      await queue.close();
      await connection.quit();
    },
  };
}
