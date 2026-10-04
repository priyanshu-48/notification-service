import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { notifications, type notificationStatus } from './db/schema.js';

type Database = NodePgDatabase<typeof schema>;
export type NotificationState = typeof notificationStatus.enumValues[number];

const legalTransitions: Record<NotificationState, readonly NotificationState[]> = {
  queued: ['sending'],
  sending: ['delivered', 'failed'],
  delivered: [],
  failed: [],
};

export function assertLegalTransition(from: NotificationState, to: NotificationState): void {
  if (!legalTransitions[from].includes(to)) throw new Error(`Illegal notification status transition: ${from} -> ${to}`);
}

export async function transitionNotification(db: Database, id: string, from: NotificationState, to: NotificationState) {
  assertLegalTransition(from, to);
  const [updated] = await db.update(notifications).set({ status: to })
    .where(and(eq(notifications.id, id), eq(notifications.status, from))).returning();
  return updated;
}
