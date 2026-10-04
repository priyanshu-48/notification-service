import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { notifications, type notificationStatus } from './db/schema.js';

type Database = NodePgDatabase<typeof schema>;
export type NotificationState = typeof notificationStatus.enumValues[number];

// sending -> queued is a retry waiting out its backoff; failed -> queued is a manual replay from the dead-letter set.
const legalTransitions: Record<NotificationState, readonly NotificationState[]> = {
  queued: ['sending'],
  sending: ['delivered', 'failed', 'queued'],
  delivered: [],
  failed: ['queued'],
};

export function assertLegalTransition(from: NotificationState, to: NotificationState): void {
  if (!legalTransitions[from].includes(to)) throw new Error(`Illegal notification status transition: ${from} -> ${to}`);
}

export async function transitionNotification(db: Database, id: string, from: NotificationState, to: NotificationState) {
  assertLegalTransition(from, to);
  const [updated] = await db.update(notifications).set({ status: to, updatedAt: sql`now()`, ...(from === 'failed' ? { attempts: 0 } : {}) })
    .where(and(eq(notifications.id, id), eq(notifications.status, from))).returning();
  return updated;
}

// Claims from `sending` too: a queue job is unique per notification and BullMQ only redelivers it after the previous
// worker's lock expired, so finding `sending` here means that worker crashed mid-send.
export async function claimNotification(db: Database, id: string) {
  const [claimed] = await db.update(notifications)
    .set({ status: 'sending', attempts: sql`${notifications.attempts} + 1`, updatedAt: sql`now()` })
    .where(and(eq(notifications.id, id), inArray(notifications.status, ['queued', 'sending']))).returning();
  return claimed;
}
