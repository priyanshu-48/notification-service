import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Redis } from 'ioredis';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type * as schema from './db/schema.js';
import { listInbox, markRead } from './inbox.js';
import type { InboxItem } from './inbox.js';
import { verifyStreamToken } from './stream-token.js';

type Database = NodePgDatabase<typeof schema>;

const topic = (userId: string) => `user:${userId}`;

export interface InAppPublisher {
  publish(userId: string, item: InboxItem): Promise<void>;
}

export function createRedisPublisher(redis: Redis): InAppPublisher {
  return { publish: async (userId, item) => { await redis.publish(topic(userId), JSON.stringify({ type: 'notification', notification: item })); } };
}

// One Redis subscriber per gateway instance; each instance only subscribes to users that have a socket on it,
// so a publish from any worker reaches whichever instances hold that user's connections.
export async function registerStream(app: FastifyInstance, db: Database, secret: string, subscriber: Redis): Promise<void> {
  await app.register(websocket);
  const rooms = new Map<string, { sockets: Set<WebSocket>; ready: Promise<unknown> }>();

  subscriber.on('message', (channel, message) => {
    for (const socket of rooms.get(channel.slice('user:'.length))?.sockets ?? []) socket.send(message);
  });
  app.addHook('onClose', async () => { subscriber.removeAllListeners('message'); await subscriber.quit(); });

  app.get('/stream', { websocket: true }, (socket, request) => {
    const token = (request.query as { token?: string }).token;
    const identity = token ? verifyStreamToken(secret, token) : null;
    if (!identity) return socket.close(4401, 'invalid token');
    const { userId, tenantId } = identity;
    const send = (value: unknown) => socket.send(JSON.stringify(value));

    // Attach listeners synchronously so no client message is dropped while we await the subscription.
    socket.on('message', (data) => {
      void (async () => {
        const msg = parseMessage(data.toString());
        if (msg?.type === 'read') send({ type: 'read', id: msg.id, ok: await markRead(db, tenantId, userId, msg.id) });
      })().catch((err) => request.log.error({ err }, 'stream message failed'));
    });
    socket.on('close', () => {
      const room = rooms.get(userId);
      room?.sockets.delete(socket);
      if (room && room.sockets.size === 0) { rooms.delete(userId); void subscriber.unsubscribe(topic(userId)).catch(() => undefined); }
    });

    void (async () => {
      let room = rooms.get(userId);
      if (!room) {
        room = { sockets: new Set(), ready: subscriber.subscribe(topic(userId)) };
        rooms.set(userId, room);
      }
      room.sockets.add(socket);
      await room.ready;
      // Subscribe BEFORE reading the backlog so nothing published in between is missed; clients dedupe by id.
      send({ type: 'inbox', notifications: await listInbox(db, tenantId, userId) });
    })().catch((err) => { request.log.error({ err }, 'stream setup failed'); socket.close(1011, 'setup failed'); });
  });
}

const readMessage = z.object({ type: z.literal('read'), id: z.string().uuid() });

function parseMessage(raw: string): { type: 'read'; id: string } | null {
  try {
    const v = readMessage.safeParse(JSON.parse(raw));
    return v.success ? v.data : null;
  } catch {
    return null;
  }
}
