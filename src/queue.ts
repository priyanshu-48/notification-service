import 'dotenv/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const notificationQueueName = 'notifications';

export interface NotificationQueue {
  add(name: string, data: { notificationId: string }): Promise<unknown>;
  close?(): Promise<void>;
}

export function createNotificationQueue(): { queue: Queue; connection: Redis } {
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(notificationQueueName, { connection });
  return { queue, connection };
}
