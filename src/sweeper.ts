import { and, inArray, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { notifications } from './db/schema.js';
import { enqueueNotification, type NotificationQueue } from './queue.js';

// Recovers notifications whose queue job is gone: enqueue failed after commit, Redis lost data, or a job exhausted
// BullMQ's stalled limit. Re-adding is a no-op while a live job exists (same jobId), so running this on every worker is safe.
export async function sweepStuckNotifications(db: NodePgDatabase<typeof schema>, queue: NotificationQueue, olderThanMs = 60_000): Promise<number> {
  const stuck = await db.select({ id: notifications.id }).from(notifications)
    .where(and(inArray(notifications.status, ['queued', 'sending']), lt(notifications.updatedAt, sql`now() - ${olderThanMs} * interval '1 millisecond'`)))
    .limit(100);
  for (const { id } of stuck) await enqueueNotification(queue, id);
  return stuck.length;
}
