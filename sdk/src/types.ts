export type Channel = 'email' | 'in_app';
export type NotificationStatus = 'queued' | 'sending' | 'delivered' | 'failed' | 'batched' | 'suppressed';

export interface QuietHours { start: string; end: string; timezone: string }
export interface Preference { channel: Channel | '*'; type: string; enabled?: boolean; quietHours?: QuietHours | null }

/** Identify the recipient by your own user id (recommended) or by the id returned from upsertUser. */
export type Recipient = { externalUserId: string; userId?: never } | { userId: string; externalUserId?: never };

export type NotificationInput = Recipient & {
  type: string;
  payload: Record<string, unknown>;
  channels?: Channel[];
  templateName?: string;
  variables?: Record<string, unknown>;
  /** Notifications with the same digestKey for one user within the window are delivered as one. */
  digestKey?: string;
  digestWindowSeconds?: number;
};

export interface SendResult { id: string; status: NotificationStatus; createdAt: string; /** true when an earlier call with the same idempotency key already created it */ replayed: boolean }
export interface UserRecord { id: string; externalUserId: string; email: string }
export interface DeliveryAttempt { channel: string; status: string; error: string | null; attemptedAt: string }
export interface NotificationSummary { id: string; type: string; status: NotificationStatus; channels: Channel[]; attempts: number; digestCount: number; createdAt: string; updatedAt: string }
export interface NotificationDetail extends Omit<NotificationSummary, 'digestCount'> { deliveryAttempts: DeliveryAttempt[] }
export interface InboxItem { id: string; type: string; payload: Record<string, unknown>; count: number; createdAt: string; readAt: string | null }
export interface Template { id: string; name: string; subject: string | null; body: string; variables: string[]; createdAt: string }
export interface StreamToken { token: string; expiresAt: string }
export interface Stats { since: string; notifications: Record<NotificationStatus, number>; attempts: Array<{ channel: string; status: string; count: number }> }
