import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { apiKeys, deliveryAttempts, notifications, templates, users } from './db/schema.js';
import { hashApiKey, hashesMatch } from './auth/key.js';
import { enqueueNotification, type NotificationQueue } from './queue.js';
import { missingTemplateVariables } from './templates.js';
import { createStreamToken } from './stream-token.js';
import { listInbox, markRead } from './inbox.js';
import { registerStream } from './realtime.js';
import type { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { RateLimiter } from './rate-limit.js';

type Database = NodePgDatabase<typeof schema>;
declare module 'fastify' {
  interface FastifyRequest { tenantId: string | null }
}

const createNotification = z.object({
  userId: z.string().uuid(),
  type: z.string().trim().min(1).max(100),
  payload: z.record(z.unknown()),
  templateName: z.string().trim().min(1).max(100).optional(),
  variables: z.record(z.unknown()).optional(),
  channels: z.array(z.enum(['email', 'in_app'])).min(1).default(['email']),
}).strict();

const createTemplate = z.object({
  name: z.string().trim().min(1).max(100),
  subject: z.string().max(998).optional(),
  body: z.string().min(1),
  variables: z.array(z.string().regex(/^[a-zA-Z_][\w.-]*$/)).default([]),
}).strict();

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } };
}

export interface StreamOptions { secret: string; subscriber: Redis }

const demoPage = readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');

export interface AppOptions { stream?: StreamOptions; rateLimiter?: RateLimiter }

// Key-order-independent JSON, so the same request body always fingerprints the same.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const idempotencyKeyHeader = z.string().min(1).max(255).optional();
const notFound = { error: { code: 'NOT_FOUND', message: 'The notification does not exist for this tenant.' } };

export function buildApp(db: Database, queue: NotificationQueue, { stream, rateLimiter }: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      // The stream token travels in the query string, so keep it out of the logs.
      serializers: { req: (req) => ({ method: req.method, url: req.url?.replace(/token=[^&]*/, 'token=[redacted]'), host: req.host, remoteAddress: req.ip }) },
    },
  });
  app.decorateRequest('tenantId', null);

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    const authorization = request.headers.authorization;
    const key = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!key) {
      return reply.code(401).send(apiError(401, 'UNAUTHORIZED', 'A valid API key is required.').body);
    }
    const keyHash = hashApiKey(key);
    const [record] = await db.select({ tenantId: apiKeys.tenantId, keyHash: apiKeys.keyHash })
      .from(apiKeys).where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt))).limit(1);
    if (!record || !hashesMatch(keyHash, record.keyHash)) {
      return reply.code(401).send(apiError(401, 'UNAUTHORIZED', 'A valid API key is required.').body);
    }
    request.tenantId = record.tenantId;

    if (rateLimiter) {
      // Fail open: a Redis outage should not take the API down with it.
      const limit = await rateLimiter.take(record.tenantId).catch((err) => { request.log.warn({ err }, 'rate limiter unavailable'); return null; });
      if (limit && !limit.allowed) {
        return reply.code(429).header('Retry-After', String(limit.retryAfterSeconds))
          .send(apiError(429, 'RATE_LIMITED', 'Too many requests for this tenant.').body);
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.', details: error.issues.map(({ path, message }) => ({ path, message })) } });
    }
    if (isBadRequestError(error)) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'The request could not be parsed.' } });
    }
    requestSafeLog(app, error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
  });

  app.post('/v1/notifications', async (request: FastifyRequest, reply) => {
    const tenantId = request.tenantId;
    if (!tenantId) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'A valid API key is required.' } });
    const input = createNotification.parse(request.body);
    const [user] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.id, input.userId), eq(users.tenantId, tenantId))).limit(1);
    if (!user) return reply.code(422).send({ error: { code: 'USER_NOT_FOUND', message: 'The user does not exist for this tenant.' } });

    let template: typeof templates.$inferSelect | undefined;
    const variables = input.variables ?? {};
    if (input.templateName) {
      [template] = await db.select().from(templates).where(and(
        eq(templates.tenantId, tenantId), eq(templates.name, input.templateName),
      )).limit(1);
      if (!template) return reply.code(422).send({ error: { code: 'TEMPLATE_NOT_FOUND', message: 'The template does not exist for this tenant.' } });
      const required = template.variables as string[];
      const missing = missingTemplateVariables(required, variables);
      if (missing.length) return reply.code(422).send({ error: { code: 'MISSING_TEMPLATE_VARIABLES', message: `Missing required template variables: ${missing.join(', ')}.` } });
    }

    const idempotencyKey = idempotencyKeyHeader.parse(request.headers['idempotency-key']) ?? null;
    const requestHash = createHash('sha256').update(canonicalJson(input)).digest('hex');
    const returning = { id: notifications.id, status: notifications.status, createdAt: notifications.createdAt };
    let [notification] = await db.insert(notifications).values({
      tenantId, userId: user.id, type: input.type, payload: input.payload, status: 'queued',
      templateName: template?.name ?? null,
      templateVariables: template ? variables : null,
      channels: [...new Set(input.channels)],
      idempotencyKey, requestHash,
    }).onConflictDoNothing({ target: [notifications.tenantId, notifications.idempotencyKey] }).returning(returning);

    let replayed = false;
    if (!notification) {
      // Only reachable with an Idempotency-Key: a duplicate call returns the original notification instead of sending again.
      const [existing] = await db.select({ ...returning, requestHash: notifications.requestHash }).from(notifications)
        .where(and(eq(notifications.tenantId, tenantId), eq(notifications.idempotencyKey, idempotencyKey!))).limit(1);
      if (!existing) return reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Please retry the request.' } });
      if (existing.requestHash !== requestHash) {
        return reply.code(422).send({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used with a different request.' } });
      }
      notification = existing;
      replayed = true;
      reply.header('Idempotent-Replayed', 'true');
      // Still `queued` means the original call may have failed to enqueue (503); re-adding is safe because jobId is the notification id.
      if (existing.status !== 'queued') return reply.code(200).send({ id: existing.id, status: existing.status, createdAt: existing.createdAt });
    }
    try {
      await enqueueNotification(queue, notification!.id);
    } catch (error) {
      request.log.error({ err: error, notificationId: notification!.id }, 'Notification persisted but enqueue failed');
      return reply.code(503).send({ id: notification!.id, error: { code: 'QUEUE_UNAVAILABLE', message: `Notification ${notification!.id} was saved as queued but could not be enqueued.` } });
    }
    return reply.code(replayed ? 200 : 201).send({ id: notification!.id, status: notification!.status, createdAt: notification!.createdAt });
  });

  app.get('/v1/notifications/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const tenantId = request.tenantId!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [notification] = await db.select({
      id: notifications.id, type: notifications.type, status: notifications.status, channels: notifications.channels,
      attempts: notifications.attempts, createdAt: notifications.createdAt, updatedAt: notifications.updatedAt,
    }).from(notifications).where(and(eq(notifications.id, id), eq(notifications.tenantId, tenantId))).limit(1);
    if (!notification) return reply.code(404).send(notFound);
    const attempts = await db.select({ channel: deliveryAttempts.channel, status: deliveryAttempts.status, error: deliveryAttempts.error, attemptedAt: deliveryAttempts.attemptedAt })
      .from(deliveryAttempts).where(eq(deliveryAttempts.notificationId, id)).orderBy(deliveryAttempts.attemptedAt);
    return reply.code(200).send({ ...notification, deliveryAttempts: attempts });
  });

  // The dead-letter set is the `failed` status: delivery was abandoned (permanent error or retries exhausted) and awaits replay.
  app.get('/v1/dead-letters', async (request: FastifyRequest, reply) => {
    const results = await db.select({ id: notifications.id, type: notifications.type, attempts: notifications.attempts, failedAt: notifications.updatedAt })
      .from(notifications).where(and(eq(notifications.tenantId, request.tenantId!), eq(notifications.status, 'failed')))
      .orderBy(desc(notifications.updatedAt)).limit(100);
    return reply.code(200).send({ notifications: results });
  });

  app.post('/v1/notifications/:id/replay', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const tenantId = request.tenantId!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [replayed] = await db.update(notifications).set({ status: 'queued', attempts: 0, updatedAt: sql`now()` })
      .where(and(eq(notifications.id, id), eq(notifications.tenantId, tenantId), eq(notifications.status, 'failed'))).returning({ id: notifications.id });
    if (!replayed) {
      const [existing] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.id, id), eq(notifications.tenantId, tenantId))).limit(1);
      return existing
        ? reply.code(409).send({ error: { code: 'NOT_REPLAYABLE', message: 'Only failed notifications can be replayed.' } })
        : reply.code(404).send(notFound);
    }
    try {
      await enqueueNotification(queue, id);
    } catch (error) {
      request.log.error({ err: error, notificationId: id }, 'Replay persisted but enqueue failed');
      return reply.code(503).send({ id, error: { code: 'QUEUE_UNAVAILABLE', message: 'The notification was re-queued and will be picked up by the sweeper.' } });
    }
    return reply.code(202).send({ id, status: 'queued' });
  });

  app.put('/v1/users/:externalUserId', async (request: FastifyRequest<{ Params: { externalUserId: string }; Body: { email: string } }>, reply) => {
    const tenantId = request.tenantId!;
    const params = z.object({ externalUserId: z.string().min(1).max(255) }).parse(request.params);
    const body = z.object({ email: z.string().email().max(320) }).strict().parse(request.body);
    const [user] = await db.insert(users).values({ tenantId, externalUserId: params.externalUserId, email: body.email })
      .onConflictDoUpdate({ target: [users.tenantId, users.externalUserId], set: { email: body.email } })
      .returning({ id: users.id, externalUserId: users.externalUserId, email: users.email });
    return reply.code(200).send(user);
  });

  app.post('/v1/templates', async (request: FastifyRequest, reply) => {
    const tenantId = request.tenantId!;
    const input = createTemplate.parse(request.body);
    const [template] = await db.insert(templates).values({ tenantId, ...input })
      .returning({ id: templates.id, name: templates.name, subject: templates.subject, body: templates.body, variables: templates.variables, createdAt: templates.createdAt });
    return reply.code(201).send(template);
  });

  app.get('/v1/templates', async (request: FastifyRequest, reply) => {
    const tenantId = request.tenantId!;
    const results = await db.select({ id: templates.id, name: templates.name, subject: templates.subject, body: templates.body, variables: templates.variables, createdAt: templates.createdAt })
      .from(templates).where(eq(templates.tenantId, tenantId));
    return reply.code(200).send({ templates: results });
  });

  const findUser = async (tenantId: string, externalUserId: string) => {
    const [user] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.externalUserId, externalUserId))).limit(1);
    return user;
  };
  const userNotFound = { error: { code: 'USER_NOT_FOUND', message: 'The user does not exist for this tenant.' } };

  app.get('/v1/users/:externalUserId/inbox', async (request: FastifyRequest<{ Params: { externalUserId: string } }>, reply) => {
    const tenantId = request.tenantId!;
    const user = await findUser(tenantId, request.params.externalUserId);
    if (!user) return reply.code(404).send(userNotFound);
    return reply.code(200).send({ notifications: await listInbox(db, tenantId, user.id) });
  });

  app.post('/v1/users/:externalUserId/inbox/:id/read', async (request: FastifyRequest<{ Params: { externalUserId: string; id: string } }>, reply) => {
    const tenantId = request.tenantId!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const user = await findUser(tenantId, request.params.externalUserId);
    if (!user) return reply.code(404).send(userNotFound);
    if (!await markRead(db, tenantId, user.id, id)) return reply.code(404).send({ error: { code: 'NOTIFICATION_NOT_FOUND', message: 'The notification does not exist for this user.' } });
    return reply.code(204).send();
  });

  if (stream) {
    // The tenant backend mints a short-lived token for its end user; the browser uses it to open /stream.
    app.post('/v1/users/:externalUserId/stream-token', async (request: FastifyRequest<{ Params: { externalUserId: string } }>, reply) => {
      const tenantId = request.tenantId!;
      const user = await findUser(tenantId, request.params.externalUserId);
      if (!user) return reply.code(404).send(userNotFound);
      return reply.code(200).send(createStreamToken(stream.secret, { userId: user.id, tenantId }));
    });
    app.get('/demo', async (_request, reply) => reply.type('text/html').send(demoPage));
    app.register(async (instance) => registerStream(instance, db, stream.secret, stream.subscriber));
  }

  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

function isBadRequestError(error: unknown): error is { statusCode: 400 } {
  return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400;
}

function requestSafeLog(app: FastifyInstance, error: unknown): void {
  app.log.error({ err: error }, 'Request failed');
}
