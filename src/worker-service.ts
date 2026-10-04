import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { deliveryAttempts, templates, users } from './db/schema.js';
import type { Channel, EmailMessage } from './channel.js';
import { renderTemplate } from './templates.js';
import { transitionNotification } from './state-machine.js';

type Database = NodePgDatabase<typeof schema>;

export async function processNotification(db: Database, channel: Channel, notificationId: string): Promise<void> {
  const notification = await transitionNotification(db, notificationId, 'queued', 'sending');
  if (!notification) return;

  try {
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
    await db.insert(deliveryAttempts).values({ notificationId, channel: channel.name, status: 'sent' });
    await transitionNotification(db, notificationId, 'sending', 'delivered');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.insert(deliveryAttempts).values({ notificationId, channel: channel.name, status: 'failed', error: message });
    await transitionNotification(db, notificationId, 'sending', 'failed');
    console.error('Notification delivery failed', { notificationId, error });
  }
}
