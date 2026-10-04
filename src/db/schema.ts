import { pgEnum, pgTable, text, timestamp, uuid, uniqueIndex, index, jsonb, boolean } from 'drizzle-orm/pg-core';

export const notificationStatus = pgEnum('notification_status', ['queued', 'sending', 'delivered', 'failed']);
export const deliveryStatus = pgEnum('delivery_status', ['pending', 'sent', 'failed']);

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  keyHash: text('key_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [index('api_keys_tenant_id_idx').on(table.tenantId)]);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  externalUserId: text('external_user_id').notNull(),
  email: text('email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('users_tenant_external_id_idx').on(table.tenantId, table.externalUserId)]);

export const preferences = pgTable('preferences', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  type: text('type').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  quietHours: jsonb('quiet_hours'),
}, (table) => [uniqueIndex('preferences_user_channel_type_idx').on(table.userId, table.channel, table.type)]);

export const templates = pgTable('templates', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  variables: jsonb('variables').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('templates_tenant_name_idx').on(table.tenantId, table.name)]);

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  templateName: text('template_name'),
  templateVariables: jsonb('template_variables').$type<Record<string, unknown>>(),
  channels: jsonb('channels').$type<Array<'email' | 'in_app'>>().notNull().default(['email']),
  status: notificationStatus('status').notNull().default('queued'),
  idempotencyKey: text('idempotency_key'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('notifications_tenant_idempotency_key_idx').on(table.tenantId, table.idempotencyKey),
  index('notifications_user_created_at_idx').on(table.userId, table.createdAt),
  index('notifications_tenant_created_at_idx').on(table.tenantId, table.createdAt),
]);

export const deliveryAttempts = pgTable('delivery_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  notificationId: uuid('notification_id').notNull().references(() => notifications.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  status: deliveryStatus('status').notNull().default('pending'),
  error: text('error'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('delivery_attempts_notification_id_idx').on(table.notificationId)]);
