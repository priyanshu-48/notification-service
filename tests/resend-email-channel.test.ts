import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermanentDeliveryError } from '../src/channel.js';
import { MockEmailChannel } from '../src/mock-email-channel.js';
import { createEmailChannel, ResendEmailChannel } from '../src/resend-email-channel.js';
import { defaultRetry, maxDeliveryAttempts } from '../src/queue.js';

// No network: fetch is stubbed. This proves the adapter's request shape and error classification, not that Resend accepts real mail.
const message = { to: 'to@example.test', subject: 'Hi', html: '<p>Hi</p>', idempotencyKey: 'n1:email' };
const channel = new ResendEmailChannel('re_test_key', 'from@example.test');
const respond = (status: number) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));

afterEach(() => vi.unstubAllGlobals());

describe('ResendEmailChannel', () => {
  it('posts the message to Resend with auth and the idempotency key', async () => {
    respond(200);
    await channel.send(message);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer re_test_key', 'Idempotency-Key': 'n1:email' });
    expect(JSON.parse(init.body)).toEqual({ from: 'from@example.test', to: ['to@example.test'], subject: 'Hi', html: '<p>Hi</p>' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits the Idempotency-Key header when the message has none', async () => {
    respond(200);
    await channel.send({ to: 'to@example.test', subject: 's', html: 'h' });
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers).not.toHaveProperty('Idempotency-Key');
  });

  it.each([400, 401, 403, 422])('treats %i as permanent: retrying cannot help', async (status) => {
    respond(status);
    await expect(channel.send(message)).rejects.toBeInstanceOf(PermanentDeliveryError);
  });

  it.each([408, 429, 500, 503])('treats %i as transient: it will be retried', async (status) => {
    respond(status);
    const error = await channel.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentDeliveryError);
  });

  it('lets a network failure or timeout propagate as a transient error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')));
    const error = await channel.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentDeliveryError);
  });
});

describe('createEmailChannel', () => {
  it('uses the mock by default or when asked', () => {
    expect(createEmailChannel({})).toBeInstanceOf(MockEmailChannel);
    expect(createEmailChannel({ EMAIL_PROVIDER: 'mock' })).toBeInstanceOf(MockEmailChannel);
  });
  it('uses Resend only with a key and a sender', () => {
    expect(createEmailChannel({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: 'f@example.test' })).toBeInstanceOf(ResendEmailChannel);
    expect(() => createEmailChannel({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' })).toThrow(/EMAIL_FROM/);
  });
});

describe('retry configuration', () => {
  it('is 5 attempts with exponential backoff from 1 s and 50% jitter', () => {
    // The integration tests shorten these delays; this pins the values that ship.
    expect(maxDeliveryAttempts).toBe(5);
    expect(defaultRetry).toEqual({ attempts: 5, backoff: { type: 'exponential', delay: 1000, jitter: 0.5 } });
  });
});
