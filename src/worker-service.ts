import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { deliveryAttempts, notifications, templates, users } from './db/schema.js';
import { PermanentDeliveryError, type Channel, type EmailMessage } from './channel.js';
import { renderTemplate } from './templates.js';
import { claimNotification, transitionNotification } from './state-machine.js';
import { maxDeliveryAttempts } from './queue.js';
import { toInboxItem } from './inbox.js';
import type { InAppPublisher } from './realtime.js';

type Database = NodePgDatabase<typeof schema>;

type Notification = typeof notifications.$inferSelect;

async function sendEmail(db: Database, channel: Channel, notification: Notification): Promise<void> {
  const [user] = await db.select({ email: users.email }).from(users)
    .where(and(eq(users.id, notification.userId), eq(users.tenantId, notification.tenantId))).limit(1);
  if (!user?.email) throw new PermanentDeliveryError('Recipient email is missing');

  let message: EmailMessage;
  if (notification.templateName) {
    const [template] = await db.select().from(templates).where(and(
      eq(templates.tenantId, notification.tenantId), eq(templates.name, notification.templateName),
    )).limit(1);
    if (!template) throw new PermanentDeliveryError('Notification template was not found for tenant');
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
  await channel.send({ ...message, idempotencyKey: `${notification.id}:email` });
}

// One delivery attempt. Retryable failures reset the row to `queued` and throw so BullMQ re-runs the job after backoff;
// permanent failures and exhausted attempts end in `failed`, which is the dead-letter set (listable and replayable).
// Channels that already have a `sent` attempt are skipped, so retries and crash redeliveries never resend them.
export async function processNotification(
  db: Database, channel: Channel, notificationId: string, publisher?: InAppPublisher, maxAttempts = maxDeliveryAttempts,
): Promise<void> {
  const notification = await claimNotification(db, notificationId);
  if (!notification) return;

  const alreadySent = new Set((await db.select({ channel: deliveryAttempts.channel }).from(deliveryAttempts)
    .where(and(eq(deliveryAttempts.notificationId, notificationId), eq(deliveryAttempts.status, 'sent')))).map((a) => a.channel));
  let failed = false;
  let permanent = false;
  for (const name of notification.channels) {
    const channelName = name === 'email' ? channel.name : name;
    if (alreadySent.has(channelName)) continue;
    try {
      if (name === 'email') await sendEmail(db, channel, notification);
      else {
        if (!publisher) throw new PermanentDeliveryError('In-app publisher is not configured');
        await publisher.publish(notification.userId, toInboxItem(notification));
      }
      await db.insert(deliveryAttempts).values({ notificationId, channel: channelName, status: 'sent' });
    } catch (error) {
      failed = true;
      permanent ||= error instanceof PermanentDeliveryError;
      const message = error instanceof Error ? error.message : String(error);
      await db.insert(deliveryAttempts).values({ notificationId, channel: channelName, status: 'failed', error: message });
      console.error('Notification delivery failed', { notificationId, channel: channelName, attempt: notification.attempts, error });
    }
  }
  if (!failed) {
    await transitionNotification(db, notificationId, 'sending', 'delivered');
  } else if (permanent || notification.attempts >= maxAttempts) {
    await transitionNotification(db, notificationId, 'sending', 'failed');
  } else {
    await transitionNotification(db, notificationId, 'sending', 'queued');
    throw new Error(`Delivery attempt ${notification.attempts} of ${maxAttempts} failed; retrying`);
  }
}
