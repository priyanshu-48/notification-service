import { createHmac, timingSafeEqual } from 'node:crypto';

export interface StreamIdentity { userId: string; tenantId: string }

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('base64url');

export function createStreamToken(secret: string, identity: StreamIdentity, ttlSeconds = 3600, now = Date.now()) {
  const expiresAt = new Date(now + ttlSeconds * 1000);
  const body = Buffer.from(JSON.stringify({ ...identity, exp: expiresAt.getTime() })).toString('base64url');
  return { token: `${body}.${sign(secret, body)}`, expiresAt };
}

export function verifyStreamToken(secret: string, token: string, now = Date.now()): StreamIdentity | null {
  const [body, signature, ...rest] = token.split('.');
  if (!body || !signature || rest.length) return null;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const { userId, tenantId, exp } = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
    if (typeof userId !== 'string' || typeof tenantId !== 'string' || typeof exp !== 'number' || exp <= now) return null;
    return { userId, tenantId };
  } catch {
    return null;
  }
}
