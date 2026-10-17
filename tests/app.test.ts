import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/auth/key.js';

const apiKey = 'ntf_live_test_key';

function fakeDb() {
  const insertValues = vi.fn().mockReturnThis();
  const returning = vi.fn().mockResolvedValue([{ id: '00000000-0000-4000-8000-000000000003', status: 'queued', createdAt: new Date('2026-01-01T00:00:00Z') }]);
  const where = vi.fn().mockReturnThis();
  const limit = vi.fn()
    .mockResolvedValueOnce([{ tenantId: '00000000-0000-4000-8000-000000000001', keyHash: hashApiKey(apiKey) }])
    .mockResolvedValueOnce([{ id: '00000000-0000-4000-8000-000000000002' }]);
  const select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where, limit }) });
  const insert = vi.fn().mockReturnValue({ values: insertValues, returning, onConflictDoNothing: vi.fn().mockReturnThis() });
  return { db: { select, insert } as never, insertValues, select };
}

describe('POST /v1/notifications', () => {
  it('requires a valid API key', async () => {
    const { db } = fakeDb();
    const app = buildApp(db, { add: vi.fn().mockResolvedValue({}) });
    const response = await app.inject({ method: 'POST', url: '/v1/notifications', payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    await app.close();
  });

  it('validates input and persists using tenant from authenticated key', async () => {
    const { db } = fakeDb();
    const app = buildApp(db, { add: vi.fn().mockResolvedValue({}) });
    const response = await app.inject({ method: 'POST', url: '/v1/notifications', headers: { authorization: `Bearer ${apiKey}` }, payload: {
      userId: '00000000-0000-4000-8000-000000000002', type: 'reminder', payload: { message: 'Take a break' }, tenantId: 'attacker-tenant',
    } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    await app.close();
  });

  it('inserts a queued notification for authenticated tenant', async () => {
    const { db, insertValues } = fakeDb();
    const app = buildApp(db, { add: vi.fn().mockResolvedValue({}) });
    const response = await app.inject({ method: 'POST', url: '/v1/notifications', headers: { authorization: `Bearer ${apiKey}` }, payload: {
      userId: '00000000-0000-4000-8000-000000000002', type: 'reminder', payload: { message: 'Take a break' },
    } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'queued' });
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ tenantId: '00000000-0000-4000-8000-000000000001', status: 'queued' }));
    await app.close();
  });

  it('returns 503 with the saved notification ID when enqueueing fails', async () => {
    const { db, insertValues } = fakeDb();
    const app = buildApp(db, { add: vi.fn().mockRejectedValue(new Error('Redis unavailable')) });
    const response = await app.inject({ method: 'POST', url: '/v1/notifications', headers: { authorization: `Bearer ${apiKey}` }, payload: {
      userId: '00000000-0000-4000-8000-000000000002', type: 'reminder', payload: {},
    } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ id: '00000000-0000-4000-8000-000000000003', error: { code: 'QUEUE_UNAVAILABLE' } });
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }));
    await app.close();
  });
});

// Fastify's own client errors (wrong content type, body too large) used to come back as a generic 500.
describe('client errors from the HTTP layer', () => {
  const send = async (options: Record<string, unknown>) => {
    const { db } = fakeDb();
    const app = buildApp(db, { add: vi.fn().mockResolvedValue({}) });
    const response = await app.inject({ method: 'POST', url: '/v1/notifications', headers: { authorization: `Bearer ${apiKey}` }, ...options } as never);
    await app.close();
    return response;
  };

  it('answers 415 for a content type the API does not accept', async () => {
    const response = await send({ headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=b' });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send the body as application/json.' } });
  });

  it('answers 413 for a body over the size limit', async () => {
    const response = await send({ headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, payload: JSON.stringify({ blob: 'x'.repeat(1_100_000) }) });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('still answers 400 for malformed JSON', async () => {
    const response = await send({ headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, payload: '{not json' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'The request could not be parsed.' } });
  });
});
