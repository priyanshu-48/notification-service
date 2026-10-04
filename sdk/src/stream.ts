import type { InboxItem } from './types.js';

export interface StreamOptions {
  /** e.g. wss://notifications.example.com/stream */
  url: string;
  /** Called before every (re)connect so an expired token is replaced. Have your backend call client.createStreamToken. */
  getToken: () => Promise<string>;
  /** Defaults to the global WebSocket (browsers, extensions, Node 22+). Pass the `ws` package's class on older Node. */
  WebSocket?: typeof WebSocket;
  /** Max delay between reconnect attempts. Default 30s. */
  maxBackoffMs?: number;
}

export type StreamStatus = 'connecting' | 'open' | 'closed';
interface Events { inbox: InboxItem[]; notification: InboxItem; status: StreamStatus; error: Error }
type Handler<K extends keyof Events> = (value: Events[K]) => void;

const maxAuthFailures = 3;

/**
 * Live notifications for one user. On every connect the server replays the inbox, then pushes new notifications. Reconnects
 * automatically with backoff. The same notification can arrive in the replay and as a live push, so key your UI by `id`:
 * `notification` events are already de-duplicated against everything this stream has seen.
 */
export class NotificationStream {
  private ws: WebSocket | undefined;
  private handlers: { [K in keyof Events]: Set<Handler<K>> } = { inbox: new Set(), notification: new Set(), status: new Set(), error: new Set() };
  private seen = new Set<string>();
  private pendingReads = new Map<string, Array<(ok: boolean) => void>>();
  private wanted = false;
  private attempt = 0;
  private authFailures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: StreamOptions) {}

  on<K extends keyof Events>(event: K, handler: Handler<K>): () => void {
    this.handlers[event].add(handler);
    return () => { this.handlers[event].delete(handler); };
  }

  private emit<K extends keyof Events>(event: K, value: Events[K]) {
    for (const handler of this.handlers[event]) handler(value);
  }

  connect(): void {
    if (this.wanted) return;
    this.wanted = true;
    void this.open();
  }

  close(): void {
    this.wanted = false;
    clearTimeout(this.timer);
    this.ws?.close(1000);
  }

  /** Mark a notification read; resolves true once the server confirms. */
  markRead(id: string): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('Stream is not connected'));
    return new Promise((resolve) => {
      this.pendingReads.set(id, [...(this.pendingReads.get(id) ?? []), resolve]);
      ws.send(JSON.stringify({ type: 'read', id }));
    });
  }

  private async open(): Promise<void> {
    this.emit('status', 'connecting');
    let token: string;
    try {
      token = await this.options.getToken();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error('getToken failed'));
      return this.scheduleReconnect();
    }
    if (!this.wanted) return;

    const WS = this.options.WebSocket ?? WebSocket;
    const ws = new WS(`${this.options.url}${this.options.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this.emit('status', 'open'); };
    ws.onmessage = (event) => this.handle(String(event.data));
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      for (const waiting of this.pendingReads.values()) waiting.forEach((resolve) => resolve(false));
      this.pendingReads.clear();
      this.emit('status', 'closed');
      if (!this.wanted) return;
      // 4401 = the server rejected the token. A fresh token usually fixes it, but don't loop forever on a bad credential.
      if (event.code === 4401 && ++this.authFailures >= maxAuthFailures) {
        this.wanted = false;
        return this.emit('error', new Error('The stream token was rejected repeatedly'));
      }
      if (event.code !== 4401) this.authFailures = 0;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.wanted) return;
    const delay = Math.min(this.options.maxBackoffMs ?? 30_000, 500 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => void this.open(), delay);
  }

  private handle(raw: string): void {
    let msg: { type?: string; notifications?: InboxItem[]; notification?: InboxItem; id?: string; ok?: boolean };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'inbox' && msg.notifications) {
      msg.notifications.forEach((n) => this.seen.add(n.id));
      this.emit('inbox', msg.notifications);
    } else if (msg.type === 'notification' && msg.notification) {
      if (this.seen.has(msg.notification.id)) return;
      this.seen.add(msg.notification.id);
      this.emit('notification', msg.notification);
    } else if (msg.type === 'read' && msg.id) {
      this.pendingReads.get(msg.id)?.forEach((resolve) => resolve(msg.ok === true));
      this.pendingReads.delete(msg.id);
    }
  }
}
