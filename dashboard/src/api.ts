export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// The API key lives in sessionStorage only: it is gone when the tab closes.
const storage = { get: () => { try { return sessionStorage.getItem('apiKey') ?? ''; } catch { return ''; } }, set: (v: string) => { try { v ? sessionStorage.setItem('apiKey', v) : sessionStorage.removeItem('apiKey'); } catch { /* storage unavailable */ } } };
let apiKey = storage.get();

export const hasKey = () => apiKey !== '';
export function setKey(key: string) { apiKey = key; storage.set(key); }

export async function api<T = unknown>(path: string, init: { method?: string } = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { authorization: `Bearer ${apiKey}` } });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!res.ok) throw new ApiError(res.status, res.status === 429 ? 'Rate limited, try again in a moment.' : body?.error?.message ?? res.statusText);
  return body as T;
}

export type Status = 'queued' | 'sending' | 'delivered' | 'failed' | 'batched' | 'suppressed';
export const statuses: Status[] = ['queued', 'sending', 'delivered', 'failed', 'batched', 'suppressed'];

export interface Stats { since: string; notifications: Record<Status, number>; attempts: Array<{ channel: string; status: string; count: number }> }
export interface LogRow { id: string; type: string; status: Status; channels: string[]; attempts: number; digestCount: number; createdAt: string; updatedAt: string }
export interface Detail extends LogRow { deliveryAttempts: Array<{ channel: string; status: string; error: string | null; attemptedAt: string }> }
export interface ApiKeyRow { id: string; createdAt: string; revokedAt: string | null }
