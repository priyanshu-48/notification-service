import type {
  InboxItem, NotificationDetail, NotificationInput, NotificationStatus, NotificationSummary, Preference, SendResult, Stats, StreamToken, Template, UserRecord,
} from './types.js';

export interface ClientOptions {
  baseUrl: string;
  /** A tenant API key. Keep it on your server: never ship it to a browser or extension. */
  apiKey: string;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
  /** Retries for requests that are safe to repeat. Default 3. */
  maxRetries?: number;
  /** First backoff delay, doubled each retry with jitter. Default 250ms. */
  retryBaseDelayMs?: number;
}

export class NotificationApiError extends Error {
  constructor(
    readonly status: number, readonly code: string, message: string,
    readonly retryAfterSeconds?: number, readonly details?: unknown,
  ) {
    super(message);
    this.name = 'NotificationApiError';
  }
}

const retryableStatuses = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RequestOptions { body?: unknown; query?: Record<string, string | number | undefined>; headers?: Record<string, string>; retry?: boolean }

export class NotificationClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: ClientOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');
    if (!options.baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  }

  // Only requests that are safe to repeat are retried: reads, PUT/DELETE, and sends carrying an idempotency key.
  private async request<T>(method: string, path: string, { body, query, headers, retry = method !== 'POST' }: RequestOptions = {}): Promise<{ data: T; response: Response }> {
    const qs = new URLSearchParams(Object.entries(query ?? {}).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)]));
    const url = `${this.baseUrl}${path}${qs.size ? `?${qs}` : ''}`;
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      const canRetry = retry && attempt < this.maxRetries;
      const backoff = this.retryBaseDelayMs * 2 ** attempt * (0.5 + Math.random() / 2);
      let response: Response;
      try {
        response = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (cause) {
        if (canRetry) { await sleep(backoff); continue; }
        throw new NotificationApiError(0, 'NETWORK_ERROR', cause instanceof Error ? cause.message : 'Network error');
      }

      const retryAfter = Number(response.headers.get('retry-after')) || undefined;
      if (canRetry && retryableStatuses.has(response.status)) { await sleep(retryAfter ? retryAfter * 1000 : backoff); continue; }
      if (response.status === 204) return { data: undefined as T, response };
      const parsed = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: unknown } } | null;
      if (!response.ok) {
        throw new NotificationApiError(response.status, parsed?.error?.code ?? 'HTTP_ERROR', parsed?.error?.message ?? response.statusText, retryAfter, parsed?.error?.details);
      }
      return { data: parsed as T, response };
    }
  }

  private async json<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    return (await this.request<T>(method, path, options)).data;
  }

  /**
   * Queue a notification. An idempotency key is generated if you don't pass one, so network retries (and the 503 returned when the
   * queue is briefly unavailable) can never produce a duplicate. Pass your own key to dedupe across separate calls,
   * e.g. a key built from the user id and date for a daily reminder.
   */
  async send(notification: NotificationInput, options: { idempotencyKey?: string } = {}): Promise<SendResult> {
    const { data, response } = await this.request<Omit<SendResult, 'replayed'>>('POST', '/v1/notifications', {
      body: notification, headers: { 'idempotency-key': options.idempotencyKey ?? crypto.randomUUID() }, retry: true,
    });
    return { ...data, replayed: response.headers.get('idempotent-replayed') === 'true' };
  }

  getNotification(id: string) { return this.json<NotificationDetail>('GET', `/v1/notifications/${id}`); }

  listNotifications(query: { status?: NotificationStatus; limit?: number; before?: string } = {}) {
    return this.json<{ notifications: NotificationSummary[]; nextBefore: string | null }>('GET', '/v1/notifications', { query });
  }

  async listDeadLetters() { return (await this.json<{ notifications: Array<{ id: string; type: string; attempts: number; failedAt: string }> }>('GET', '/v1/dead-letters')).notifications; }

  /** Re-queue a failed notification. */
  replayNotification(id: string) { return this.json<{ id: string; status: 'queued' }>('POST', `/v1/notifications/${id}/replay`, { retry: false }); }

  upsertUser(externalUserId: string, user: { email: string }) { return this.json<UserRecord>('PUT', `/v1/users/${encodeURIComponent(externalUserId)}`, { body: user }); }

  async getPreferences(externalUserId: string) { return (await this.json<{ preferences: Preference[] }>('GET', `/v1/users/${encodeURIComponent(externalUserId)}/preferences`)).preferences; }

  /** Replaces the user's whole preference set. */
  async setPreferences(externalUserId: string, preferences: Preference[]) {
    return (await this.json<{ preferences: Preference[] }>('PUT', `/v1/users/${encodeURIComponent(externalUserId)}/preferences`, { body: { preferences } })).preferences;
  }

  async getInbox(externalUserId: string) { return (await this.json<{ notifications: InboxItem[] }>('GET', `/v1/users/${encodeURIComponent(externalUserId)}/inbox`)).notifications; }

  async markRead(externalUserId: string, notificationId: string) {
    await this.json('POST', `/v1/users/${encodeURIComponent(externalUserId)}/inbox/${notificationId}/read`, { retry: true });
  }

  /** Mint a one-hour token your end user's browser can use to open the live stream. Call this from your backend. */
  createStreamToken(externalUserId: string) { return this.json<StreamToken>('POST', `/v1/users/${encodeURIComponent(externalUserId)}/stream-token`, { retry: false }); }

  createTemplate(template: { name: string; subject?: string; body: string; variables?: string[] }) { return this.json<Template>('POST', '/v1/templates', { body: template, retry: false }); }
  async listTemplates() { return (await this.json<{ templates: Template[] }>('GET', '/v1/templates')).templates; }

  getStats(hours?: number) { return this.json<Stats>('GET', '/v1/stats', { query: { hours } }); }
}
