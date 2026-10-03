import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './db/schema.js';
import { apiKeys, notifications, users } from './db/schema.js';
import { hashApiKey, hashesMatch } from './auth/key.js';

type Database = NodePgDatabase<typeof schema>;
declare module 'fastify' {
  interface FastifyRequest { tenantId: string | null }
}

const createNotification = z.object({
  userId: z.string().uuid(),
  type: z.string().trim().min(1).max(100),
  payload: z.record(z.unknown()),
}).strict();

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } };
}

export function buildApp(db: Database): FastifyInstance {
  const app = Fastify({ logger: true });
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

    const [notification] = await db.insert(notifications).values({
      tenantId, userId: user.id, type: input.type, payload: input.payload, status: 'queued',
    }).returning({ id: notifications.id, status: notifications.status, createdAt: notifications.createdAt });
    return reply.code(201).send({ id: notification!.id, status: notification!.status, createdAt: notification!.createdAt });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

function isBadRequestError(error: unknown): error is { statusCode: 400 } {
  return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400;
}

function requestSafeLog(app: FastifyInstance, error: unknown): void {
  app.log.error({ err: error }, 'Request failed');
}
