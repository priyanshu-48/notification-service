import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { deliveryAttempts, notifications, templates, users } from './db/schema.js';
import type { Channel, EmailMessage } from './channel.js';
import { renderTemplate } from './templates.js';
import { transitionNotification } from './state-machine.js';
import { toInboxItem } from './inbox.js';
import type { InAppPublisher } from './realtime.js';

type Database = NodePgDatabase<typeof schema>;

type Notification = typeof notifications.$inferSelect;

async function sendEmail(db: Database, channel: Channel, notification: Notification): Promise<void> {
  const [user] = await db.select({ email: users.email }).from(users)
    .where(and(eq(users.id, notification.userId), eq(users.tenantId, notification.tenantId))).limit(1);
  if (!user?.email) throw new Error('Recipient email is missing');

  let message: EmailMessage;
  if (notification.templateName) {
    const [template] = await db.select().from(templates).where(and(
      eq(templates.tenantId, notification.tenantId), eq(templates.name, notification.templateName),
    )).limit(1);
    if (!template) throw new Error('Notification template was not found for tenant');
    const variables = notification.templateVariables ?? {};
    message = {
      to: user.email,
      subject: renderTemplate(template.subject ?? template.name, variables, false),
      html: renderTemplate(template.body, variables, true),
    };
  } else {
    const payload = notification.payload as Record<string, unknown>;
    message = {
      to: user.email,
      subject: typeof payload.subject === 'string' ? payload.subject : notification.type,
      html: typeof payload.body === 'string' ? payload.body : JSON.stringify(payload),
    };
  }
  await channel.send(message);
}

// Each requested channel is attempted independently; any failure marks the notification failed (per-channel retry is Phase 4).
export async function processNotification(db: Database, channel: Channel, notificationId: string, publisher?: InAppPublisher): Promise<void> {
  const notification = await transitionNotification(db, notificationId, 'queued', 'sending');
  if (!notification) return;

  let failed = false;
  for (const name of notification.channels) {
    const channelName = name === 'email' ? channel.name : name;
    try {
      if (name === 'email') await sendEmail(db, channel, notification);
      else {
        if (!publisher) throw new Error('In-app publisher is not configured');
        await publisher.publish(notification.userId, toInboxItem(notification));
      }
      await db.insert(deliveryAttempts).values({ notificationId, channel: channelName, status: 'sent' });
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      await db.insert(deliveryAttempts).values({ notificationId, channel: channelName, status: 'failed', error: message });
      console.error('Notification delivery failed', { notificationId, channel: channelName, error });
    }
  }
  await transitionNotification(db, notificationId, 'sending', failed ? 'failed' : 'delivered');
}
