import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { notifications } from './db/schema.js';

type Database = NodePgDatabase<typeof schema>;

export interface InboxItem { id: string; type: string; payload: unknown; createdAt: Date; readAt: Date | null }

export function toInboxItem(row: Pick<typeof notifications.$inferSelect, 'id' | 'type' | 'payload' | 'createdAt' | 'readAt'>): InboxItem {
  return { id: row.id, type: row.type, payload: row.payload, createdAt: row.createdAt, readAt: row.readAt };
}

// The inbox is simply the user's in-app notifications; the DB row is the durable copy that Redis pub/sub only mirrors live.
export async function listInbox(db: Database, tenantId: string, userId: string, limit = 50): Promise<InboxItem[]> {
  const rows = await db.select().from(notifications)
    .where(and(eq(notifications.tenantId, tenantId), eq(notifications.userId, userId), sql`${notifications.channels} ? 'in_app'`))
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
