import { describe, expect, it, vi } from 'vitest';
import { NotificationApiError, NotificationClient } from '../sdk/src/index.js';
import { NotificationStream } from '../sdk/src/index.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const client = (fetch: typeof globalThis.fetch, extra = {}) =>
  new NotificationClient({ baseUrl: 'https://n.example.test/', apiKey: 'ntf_live_x', fetch, retryBaseDelayMs: 1, ...extra });
const sent = { id: 'n1', status: 'queued', createdAt: '2026-01-01T00:00:00Z' };

describe('NotificationClient', () => {
  it('sends the key, builds the URL and reuses one idempotency key across retries', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(503, { error: { code: 'QUEUE_UNAVAILABLE', message: 'later' } })).mockResolvedValueOnce(json(201, sent));
    const result = await client(fetch).send({ externalUserId: 'u 1', type: 'alert', payload: {} });
    expect(result).toEqual({ ...sent, replayed: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [[url, first], [, second]] = fetch.mock.calls as Array<[string, RequestInit]>;
    expect(url).toBe('https://n.example.test/v1/notifications');
    expect((first.headers as Record<string, string>).authorization).toBe('Bearer ntf_live_x');
    const key = (first.headers as Record<string, string>)['idempotency-key'];
    expect(key).toBeTruthy();
    expect((second.headers as Record<string, string>)['idempotency-key']).toBe(key);
  });

  it('reports a replay and honours a caller-supplied key', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, sent, { 'idempotent-replayed': 'true' }));
    const result = await client(fetch).send({ userId: 'u', type: 't', payload: {} }, { idempotencyKey: 'streak:u:2026-01-01' });
    expect(result.replayed).toBe(true);
    expect(((fetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>)['idempotency-key']).toBe('streak:u:2026-01-01');
  });

  it('does not retry client errors and exposes status, code and details', async () => {
    const fetch = vi.fn().mockResolvedValue(json(400, { error: { code: 'VALIDATION_ERROR', message: 'bad', details: [{ path: ['type'] }] } }));
    const error = await client(fetch).send({ userId: 'u', type: '', payload: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(NotificationApiError);
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', details: [{ path: ['type'] }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries 429 and network errors for reads, then gives up with NETWORK_ERROR', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(429, { error: { code: 'RATE_LIMITED', message: 'slow' } }, { 'retry-after': '0' }))
      .mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(200, { notifications: [] }));
    expect(await client(fetch).getInbox('u')).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);

    const down = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(client(down, { maxRetries: 2 }).getInbox('u')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    expect(down).toHaveBeenCalledTimes(3);
  });

  it('never retries calls that are not safe to repeat', async () => {
    const fetch = vi.fn().mockResolvedValue(json(503, { error: { code: 'X', message: 'x' } }));
    await expect(client(fetch).createStreamToken('u')).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('encodes ids in paths and handles 204', async () => {
    const fetch = vi.fn().mockResolvedValue(json(204, null));
    await client(fetch).markRead('a/b c', 'n1');
    expect((fetch.mock.calls[0] as [string])[0]).toBe('https://n.example.test/v1/users/a%2Fb%20c/inbox/n1/read');
  });

  it('deleteUser sends DELETE to the encoded path, returns nothing, and is safe to retry', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(503, { error: { code: 'QUEUE_UNAVAILABLE', message: 'later' } })).mockResolvedValueOnce(json(204, null));
    await expect(client(fetch).deleteUser('a/b c')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://n.example.test/v1/users/a%2Fb%20c');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('requires an api key and base url', () => {
    expect(() => new NotificationClient({ baseUrl: 'x', apiKey: '' })).toThrow('apiKey');
    expect(() => new NotificationClient({ baseUrl: '', apiKey: 'k' })).toThrow('baseUrl');
  });
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: (e: { code: number }) => void;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); }
  push(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}
const item = (id: string) => ({ id, type: 't', payload: {}, count: 1, createdAt: '2026-01-01T00:00:00Z', readAt: null });
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
function makeStream(getToken = vi.fn().mockResolvedValue('tok')) {
  FakeSocket.instances = [];
  const stream = new NotificationStream({ url: 'wss://n.example.test/stream', getToken, WebSocket: FakeSocket as unknown as typeof WebSocket, maxBackoffMs: 5 });
  return { stream, getToken };
}

describe('NotificationStream', () => {
  it('connects with the token and de-duplicates backlog against live pushes', async () => {
    const { stream } = makeStream();
    const inbox = vi.fn(); const live = vi.fn();
    stream.on('inbox', inbox); stream.on('notification', live);
    stream.connect();
    await tick();
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe('wss://n.example.test/stream?token=tok');
    socket.open();
    socket.push({ type: 'notification', notification: item('a') }); // live push racing the backlog
    socket.push({ type: 'inbox', notifications: [item('a'), item('b')] });
    socket.push({ type: 'notification', notification: item('a') }); // already in the backlog
    socket.push({ type: 'notification', notification: item('c') });
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(live.mock.calls.map(([n]) => n.id)).toEqual(['a', 'c']);
    stream.close();
  });

  it('resolves markRead from the server ack and rejects when disconnected', async () => {
    const { stream } = makeStream();
    await expect(stream.markRead('a')).rejects.toThrow('not connected');
    stream.connect();
    await tick();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    const result = stream.markRead('a');
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'read', id: 'a' });
    socket.push({ type: 'read', id: 'a', ok: true });
    await expect(result).resolves.toBe(true);
    stream.close();
  });

  it('reconnects with a fresh token after a drop', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('t1').mockResolvedValueOnce('t2');
    const { stream } = makeStream(getToken);
    stream.connect();
    await tick();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.close(1006);
    await tick(50);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.url).toContain('token=t2');
    stream.close();
  });

  it('stops after repeated token rejections instead of looping', async () => {
    const { stream, getToken } = makeStream();
    const errors = vi.fn();
    stream.on('error', errors);
    stream.connect();
    for (let i = 0; i < 3; i++) {
      await tick(30);
      FakeSocket.instances[i]!.close(4401);
    }
    await tick(50);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(3);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('does not reconnect after close()', async () => {
    const { stream } = makeStream();
    stream.connect();
    await tick();
    FakeSocket.instances[0]!.open();
    stream.close();
    await tick(50);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
