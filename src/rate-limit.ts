import type { Redis } from 'ioredis';

export interface RateLimiter {
  take(tenantId: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

// Token bucket in Redis so the limit is shared by every API instance. The script uses Redis TIME so instance clock skew can't matter,
// and runs atomically, so concurrent requests can't over-spend the bucket.
const script = `
local rate, cap = tonumber(ARGV[1]), tonumber(ARGV[2])
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(d[1]) or cap
local ts = tonumber(d[2]) or now
tokens = math.min(cap, tokens + (now - ts) * rate / 1000)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + 1000)
return { allowed, math.ceil((1 - tokens) / rate) }
`;

export function createRateLimiter(redis: Redis, { perMinute, burst }: { perMinute: number; burst: number }): RateLimiter {
  const rate = perMinute / 60;
  return {
    async take(tenantId) {
      const [allowed, retryAfter] = await redis.eval(script, 1, `ratelimit:${tenantId}`, rate, burst) as [number, number];
      return { allowed: allowed === 1, retryAfterSeconds: Math.max(1, retryAfter) };
    },
  };
}
