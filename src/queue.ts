import 'dotenv/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const notificationQueueName = 'notifications';

export const maxDeliveryAttempts = 5;
// Exponential backoff (1s, 2s, 4s, ...) with 50% jitter so retries after a provider outage don't arrive in lockstep.
export const defaultRetry = { attempts: maxDeliveryAttempts, backoff: { type: 'exponential', delay: 1000, jitter: 0.5 } } as const;

export interface NotificationQueue {
  add(name: string, data: { notificationId: string }, opts?: object): Promise<unknown>;
  close?(): Promise<void>;
}

// jobId = notification id makes enqueueing idempotent while a job is live, so the sweeper and client retries can re-add safely.
// Finished jobs are removed so a replay of the same notification can be enqueued again.
export function enqueueNotification(queue: NotificationQueue, notificationId: string, { retry = defaultRetry as object, delayMs = 0 } = {}) {
  return queue.add('deliver-notification', { notificationId }, {
    jobId: notificationId, removeOnComplete: true, removeOnFail: true, ...retry, ...(delayMs > 0 ? { delay: delayMs } : {}),
  });
}

export function createNotificationQueue(): { queue: Queue; connection: Redis } {
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(notificationQueueName, { connection });
  return { queue, connection };
}
