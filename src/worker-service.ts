import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DelayedError, type Job } from 'bullmq';
import type * as schema from './db/schema.js';
import { deliveryAttempts, notifications, preferences, templates, users } from './db/schema.js';
import { PermanentDeliveryError, type Channel, type EmailMessage } from './channel.js';
import { escapeHtml, renderTemplate } from './templates.js';
import { claimNotification, deferNotification, transitionNotification } from './state-machine.js';
import { maxDeliveryAttempts } from './queue.js';
import { toInboxItem } from './inbox.js';
import { quietUntil, resolvePreference, type Preference } from './preferences.js';
import type { InAppPublisher } from './realtime.js';

type Database = NodePgDatabase<typeof schema>;
type Notification = typeof notifications.$inferSelect;

export interface ProcessOptions { publisher?: InAppPublisher; maxAttempts?: number; now?: Date }

// Thrown when every remaining channel is inside the user's quiet hours; the queue handler reschedules the job for `until`.
export class DeferredError extends Error {
  constructor(readonly until: Date) { super(`Deferred until ${until.toISOString()} (quiet hours)`); }
}

const itemText = (payload: Record<string, unknown>, fallback: string) =>
  [payload.title, payload.message, payload.body].find((v): v is string => typeof v === 'string') ?? fallback;

async function sendEmail(db: Database, channel: Channel, notification: Notification, digestItems: Array<Record<string, unknown>>): Promise<void> {
  const [user] = await db.select({ email: users.email }).from(users)
    .where(and(eq(users.id, notification.userId), eq(users.tenantId, notification.tenantId))).limit(1);
  if (!user?.email) throw new PermanentDeliveryError('Recipient email is missing');

  const count = notification.digestCount;
  let message: EmailMessage;
  if (notification.templateName) {
    const [template] = await db.select().from(templates).where(and(
      eq(templates.tenantId, notification.tenantId), eq(templates.name, notification.templateName),
    )).limit(1);
    if (!template) throw new PermanentDeliveryError('Notification template was not found for tenant');
    const variables = { ...(notification.templateVariables ?? {}), count };
    message = {
      to: user.email,
      subject: renderTemplate(template.subject ?? template.name, variables, false),
      html: renderTemplate(template.body, variables, true),
    };
  } else if (count > 1) {
    const items = [notification.payload as Record<string, unknown>, ...digestItems];
    message = {
      to: user.email,
      subject: `${count} new ${notification.type} notifications`,
      html: `<ul>${items.map((p) => `<li>${escapeHtml(itemText(p, notification.type))}</li>`).join('')}</ul>${count > items.length ? `<p>and ${count - items.length} more</p>` : ''}`,
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

// Digest leader = the first notification of a window to run. In one statement it absorbs every other queued notification for the same
// user and digestKey, so concurrent arrivals either join this digest or start the next one; none can be left behind.
async function absorbDigest(db: Database, leader: Notification): Promise<{ leader: Notification; items: Array<Record<string, unknown>> }> {
  if (!leader.digestKey) return { leader, items: [] };
  await db.update(notifications).set({ status: 'batched', digestParentId: leader.id, updatedAt: sql`now()` })
    .where(and(eq(notifications.tenantId, leader.tenantId), eq(notifications.userId, leader.userId), eq(notifications.digestKey, leader.digestKey),
      eq(notifications.status, 'queued'), ne(notifications.id, leader.id)));
  const children = await db.select({ payload: notifications.payload }).from(notifications)
    .where(eq(notifications.digestParentId, leader.id)).orderBy(asc(notifications.createdAt));
  const [updated] = await db.update(notifications).set({ digestCount: 1 + children.length }).where(eq(notifications.id, leader.id)).returning();
  return { leader: updated!, items: children.slice(0, 19).map((c) => c.payload as Record<string, unknown>) };
}

// One delivery attempt. Retryable failures reset the row to `queued` and throw so BullMQ re-runs the job after backoff;
// permanent failures and exhausted attempts end in `failed`, which is the dead-letter set (listable and replayable).
// Channels that already have a `sent` or `skipped` attempt are not repeated, so retries and crash redeliveries never resend them.
export async function processNotification(db: Database, channel: Channel, notificationId: string, options: ProcessOptions = {}): Promise<void> {
  const { publisher, maxAttempts = maxDeliveryAttempts, now = new Date() } = options;
  const claimed = await claimNotification(db, notificationId);
  if (!claimed) return;
  const { leader: notification, items } = await absorbDigest(db, claimed);

  const prefs = await db.select({ channel: preferences.channel, type: preferences.type, enabled: preferences.enabled, quietHours: preferences.quietHours })
    .from(preferences).where(eq(preferences.userId, notification.userId)) as Preference[];
  const previous = await db.select({ channel: deliveryAttempts.channel, status: deliveryAttempts.status }).from(deliveryAttempts)
    .where(and(eq(deliveryAttempts.notificationId, notificationId), inArray(deliveryAttempts.status, ['sent', 'skipped'])));
  const done = new Set(previous.map((a) => a.channel));
  let anySent = previous.some((a) => a.status === 'sent');
  let failed = false;
  let permanent = false;
  const deferrals: Date[] = [];

  for (const name of notification.channels) {
    const channelName = name === 'email' ? channel.name : name;
    if (done.has(channelName)) continue;

    const pref = resolvePreference(prefs, name, notification.type);
    if (!pref.enabled) {
      await db.insert(deliveryAttempts).values({ notificationId, channel: channelName, status: 'skipped', error: 'recipient opted out' });
      continue;
    }
    const until = pref.quietHours && quietUntil(pref.quietHours, now);
    if (until) { deferrals.push(until); continue; }

    try {
      if (name === 'email') await sendEmail(db, channel, notification, items);
      else {
        if (!publisher) throw new PermanentDeliveryError('In-app publisher is not configured');
        await publisher.publish(notification.userId, toInboxItem(notification));
      }
      await db.insert(deliveryAttempts).values({ notificationId, channel: channelName, status: 'sent' });
      anySent = true;
    } catch (error) {
      failed = true;
      permanent ||= error instanceof PermanentDeliveryError;
      const message = error instanceof Error ? error.message : String(error);
      await db.insert(deliveryAttempts).values({ notificationId, channel: channelName, status: 'failed', error: message });
      console.error('Notification delivery failed', { notificationId, channel: channelName, attempt: notification.attempts, error });
    }
  }

  if (failed && (permanent || notification.attempts >= maxAttempts)) {
    await transitionNotification(db, notificationId, 'sending', 'failed'); // absorbed children stay `batched`, so a replay re-sends the whole digest
  } else if (failed) {
    await transitionNotification(db, notificationId, 'sending', 'queued');
    throw new Error(`Delivery attempt ${notification.attempts} of ${maxAttempts} failed; retrying`);
  } else if (deferrals.length) {
    const until = new Date(Math.min(...deferrals.map((d) => d.getTime())));
    await deferNotification(db, notificationId, until);
    throw new DeferredError(until);
  } else {
    const final = anySent ? 'delivered' : 'suppressed';
    await transitionNotification(db, notificationId, 'sending', final);
    await db.update(notifications).set({ status: final, updatedAt: sql`now()` })
      .where(and(eq(notifications.digestParentId, notificationId), eq(notifications.status, 'batched')));
  }
}

// BullMQ processor: a quiet-hours deferral moves the live job to the delayed set instead of failing or completing it.
export function createJobHandler(db: Database, channel: Channel, publisher?: InAppPublisher) {
  return async (job: Job, token?: string): Promise<void> => {
    if (typeof job.data.notificationId !== 'string') throw new Error('Invalid notification job');
    try {
      await processNotification(db, channel, job.data.notificationId, { ...(publisher ? { publisher } : {}) });
    } catch (error) {
      if (!(error instanceof DeferredError)) throw error;
      await job.moveToDelayed(error.until.getTime(), token);
      throw new DelayedError();
    }
  };
}
