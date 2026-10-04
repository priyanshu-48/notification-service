import { describe, expect, it } from 'vitest';
import { assertLegalTransition } from '../src/state-machine.js';

describe('notification state machine', () => {
  it.each([
    ['queued', 'sending'],
    ['sending', 'delivered'],
    ['sending', 'failed'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => assertLegalTransition(from, to)).not.toThrow();
  });

  it.each([
    ['queued', 'delivered'],
    ['queued', 'failed'],
    ['sending', 'queued'],
    ['delivered', 'sending'],
    ['failed', 'sending'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => assertLegalTransition(from, to)).toThrow(/Illegal notification status transition/);
  });
});
