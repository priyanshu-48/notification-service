import { describe, expect, it } from 'vitest';
import { createStreamToken, verifyStreamToken } from '../src/stream-token.js';

const secret = 'a'.repeat(32);
const identity = { userId: 'u1', tenantId: 't1' };

describe('stream tokens', () => {
  it('round-trips an identity', () => {
    expect(verifyStreamToken(secret, createStreamToken(secret, identity).token)).toEqual(identity);
  });

  it('rejects expired, tampered, wrong-secret and malformed tokens', () => {
    const { token } = createStreamToken(secret, identity, 60, 0);
    expect(verifyStreamToken(secret, token, 61_000)).toBeNull();
    expect(verifyStreamToken('b'.repeat(32), token, 1)).toBeNull();
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...identity, userId: 'u2', exp: 9e15 })).toString('base64url');
    expect(verifyStreamToken(secret, `${forged}.${sig}`, 1)).toBeNull();
    expect(verifyStreamToken(secret, `${body}.${sig}.x`, 1)).toBeNull();
    expect(verifyStreamToken(secret, 'garbage', 1)).toBeNull();
  });
});
