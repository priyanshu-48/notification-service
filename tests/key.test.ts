import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, hashesMatch } from '../src/auth/key.js';

describe('API key utilities', () => {
  it('generates recognizable high-entropy keys and stores only a one-way hash', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^ntf_live_[A-Za-z0-9_-]{43}$/);
    expect(hashApiKey(key)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashApiKey(key)).not.toBe(key);
  });

  it('compares hashes and rejects mismatches', () => {
    const hash = hashApiKey('ntf_live_example');
    expect(hashesMatch(hash, hash)).toBe(true);
    expect(hashesMatch(hash, hashApiKey('different'))).toBe(false);
  });
});
