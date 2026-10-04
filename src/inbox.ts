import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { deliveryAttempts, notifications } from './db/schema.js';

type Database = NodePgDatabase<typeof schema>;

export interface InboxItem { id: string; type: string; payload: unknown; count: number; createdAt: Date; readAt: Date | null }

export function toInboxItem(row: Pick<typeof notifications.$inferSelect, 'id' | 'type' | 'payload' | 'digestCount' | 'createdAt' | 'readAt'>): InboxItem {
  return { id: row.id, type: row.type, payload: row.payload, count: row.digestCount, createdAt: row.createdAt, readAt: row.readAt };
}

// The inbox is what was actually delivered in-app (a `sent` in_app attempt), so notifications held back by a digest window or
// quiet hours don't appear early, and absorbed digest members show only through their leader. Redis pub/sub just mirrors this live.
export async function listInbox(db: Database, tenantId: string, userId: string, limit = 50): Promise<InboxItem[]> {
  const rows = await db.select().from(notifications)
    .where(and(eq(notifications.tenantId, tenantId), eq(notifications.userId, userId), isNull(notifications.digestParentId),
      sql`exists (select 1 from ${deliveryAttempts} where ${deliveryAttempts.notificationId} = ${notifications.id} and ${deliveryAttempts.channel} = 'in_app' and ${deliveryAttempts.status} = 'sent')`))
    .orderBy(desc(notifications.createdAt)).limit(limit);
  return rows.map(toInboxItem);
}

// Idempotent: coalesce keeps the first read time, so repeated acks succeed without rewriting it.
export async function markRead(db: Database, tenantId: string, userId: string, id: string): Promise<boolean> {
  const rows = await db.update(notifications).set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(eq(notifications.id, id), eq(notifications.tenantId, tenantId), eq(notifications.userId, userId)))
    .returning({ id: notifications.id });
  return rows.length > 0;
}
