import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, count, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type * as schema from './db/schema.js';
import { apiKeys, deliveryAttempts, notifications, preferences, users } from './db/schema.js';
import { generateApiKey, hashApiKey } from './auth/key.js';
import { preferenceSchema } from './preferences.js';

type Database = NodePgDatabase<typeof schema>;

const userNotFound = { error: { code: 'USER_NOT_FOUND', message: 'The user does not exist for this tenant.' } };
const statuses = ['queued', 'sending', 'delivered', 'failed', 'batched', 'suppressed'] as const;

// Preferences, dashboard statistics/log and API key management. Everything is scoped to request.tenantId (set by the auth hook).
export function registerManagementRoutes(app: FastifyInstance, db: Database): void {
  const findUser = async (tenantId: string, externalUserId: string) => {
    const [user] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.externalUserId, externalUserId))).limit(1);
    return user;
  };

  app.get('/v1/users/:externalUserId/preferences', async (request: FastifyRequest<{ Params: { externalUserId: string } }>, reply) => {
    const user = await findUser(request.tenantId!, request.params.externalUserId);
    if (!user) return reply.code(404).send(userNotFound);
    const rows = await db.select({ channel: preferences.channel, type: preferences.type, enabled: preferences.enabled, quietHours: preferences.quietHours })
      .from(preferences).where(eq(preferences.userId, user.id));
    return reply.code(200).send({ preferences: rows });
  });

  // PUT replaces the user's whole preference set, so it is idempotent and a removed row means "back to the default".
  app.put('/v1/users/:externalUserId/preferences', async (request: FastifyRequest<{ Params: { externalUserId: string } }>, reply) => {
    const body = z.object({ preferences: z.array(preferenceSchema).max(100) }).strict().parse(request.body);
    const keys = body.preferences.map((p) => `${p.channel}/${p.type}`);
    if (new Set(keys).size !== keys.length) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Each channel/type pair may appear only once.' } });
    }
    const user = await findUser(request.tenantId!, request.params.externalUserId);
    if (!user) return reply.code(404).send(userNotFound);
    await db.transaction(async (tx) => {
      await tx.delete(preferences).where(eq(preferences.userId, user.id));
      if (body.preferences.length) await tx.insert(preferences).values(body.preferences.map((p) => ({ ...p, userId: user.id })));
    });
    return reply.code(200).send({ preferences: body.preferences });
  });

  app.get('/v1/stats', async (request: FastifyRequest<{ Querystring: { hours?: string } }>, reply) => {
    const tenantId = request.tenantId!;
    const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) }).parse(request.query);
    const since = new Date(Date.now() - hours * 3600_000);
    const byStatus = await db.select({ status: notifications.status, n: count() }).from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), gte(notifications.createdAt, since))).groupBy(notifications.status);
    const byChannel = await db.select({ channel: deliveryAttempts.channel, status: deliveryAttempts.status, n: count() }).from(deliveryAttempts)
      .innerJoin(notifications, eq(notifications.id, deliveryAttempts.notificationId))
      .where(and(eq(notifications.tenantId, tenantId), gte(deliveryAttempts.attemptedAt, since))).groupBy(deliveryAttempts.channel, deliveryAttempts.status);
    const counts = Object.fromEntries(statuses.map((s) => [s, byStatus.find((r) => r.status === s)?.n ?? 0]));
    return reply.code(200).send({ since, notifications: counts, attempts: byChannel.map((r) => ({ channel: r.channel, status: r.status, count: r.n })) });
  });

  // Newest first. The cursor is the last row's createdAt; rows created in the same millisecond could straddle a page boundary.
  app.get('/v1/notifications', async (request: FastifyRequest, reply) => {
    const query = z.object({
      status: z.enum(statuses).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), before: z.coerce.date().optional(),
    }).parse(request.query);
    const rows = await db.select({
      id: notifications.id, type: notifications.type, status: notifications.status, channels: notifications.channels,
      attempts: notifications.attempts, digestCount: notifications.digestCount, createdAt: notifications.createdAt, updatedAt: notifications.updatedAt,
    }).from(notifications).where(and(
      eq(notifications.tenantId, request.tenantId!),
      query.status ? eq(notifications.status, query.status) : undefined,
      query.before ? lt(notifications.createdAt, query.before) : undefined,
    )).orderBy(desc(notifications.createdAt)).limit(query.limit);
    return reply.code(200).send({ notifications: rows, nextBefore: rows.length === query.limit ? rows.at(-1)!.createdAt : null });
  });

  app.get('/v1/api-keys', async (request: FastifyRequest, reply) => {
    const rows = await db.select({ id: apiKeys.id, createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt }).from(apiKeys)
      .where(eq(apiKeys.tenantId, request.tenantId!)).orderBy(desc(apiKeys.createdAt));
    return reply.code(200).send({ apiKeys: rows });
  });

  // The plaintext key is returned once here; only its hash is stored.
  app.post('/v1/api-keys', async (request: FastifyRequest, reply) => {
    const key = generateApiKey();
    const [row] = await db.insert(apiKeys).values({ tenantId: request.tenantId!, keyHash: hashApiKey(key) }).returning({ id: apiKeys.id, createdAt: apiKeys.createdAt });
    return reply.code(201).send({ ...row, key });
  });

  app.delete('/v1/api-keys/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const tenantId = request.tenantId!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [target] = await db.select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt }).from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId))).limit(1);
    if (!target) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'The API key does not exist for this tenant.' } });
    if (!target.revokedAt) {
      // Never revoke the last active key: the tenant would lock itself out with no way to create another.
      const [{ active }] = await db.select({ active: count() }).from(apiKeys).where(and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt))) as [{ active: number }];
      if (active <= 1) return reply.code(409).send({ error: { code: 'LAST_ACTIVE_KEY', message: 'Create another API key before revoking the last active one.' } });
      await db.update(apiKeys).set({ revokedAt: sql`now()` }).where(eq(apiKeys.id, id));
    }
    return reply.code(204).send();
  });
}
