import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, hasKey, setKey, statuses, type ApiKeyRow, type Detail, type LogRow, type Stats, type Status } from './api';

type Tab = 'overview' | 'log' | 'dead' | 'keys';
const tabs: Array<[Tab, string]> = [['overview', 'Overview'], ['log', 'Notifications'], ['dead', 'Dead letters'], ['keys', 'API keys']];

const when = (iso: string) => new Date(iso).toLocaleString();
const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

// Runs a loader on mount and on a timer, keeping the last good data if a refresh fails.
function useLoad<T>(load: () => Promise<T>, deps: unknown[], refreshMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const stableLoad = useCallback(load, deps);
  useEffect(() => {
    let live = true;
    stableLoad().then((d) => { if (live) { setData(d); setError(''); } }, (e) => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [stableLoad, tick]);
  useEffect(() => {
    if (!refreshMs) return;
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

function Badge({ status }: { status: string }) { return <span className={`badge ${status}`}>{status}</span>; }
function ErrorBox({ text }: { text: string }) { return text ? <p className="error" role="alert">{text}</p> : null; }

export function App() {
  const [authed, setAuthed] = useState(hasKey());
  const [tab, setTab] = useState<Tab>('overview');
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <div className="shell">
      <header>
        <h1>Notifications</h1>
        <nav>{tabs.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
        <button className="link" onClick={() => { setKey(''); setAuthed(false); }}>Sign out</button>
      </header>
      <main>
        {tab === 'overview' && <Overview />}
        {tab === 'log' && <Log />}
        {tab === 'dead' && <DeadLetters />}
        {tab === 'keys' && <Keys />}
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setKey(value.trim());
    try { await api('/v1/stats?hours=1'); onDone(); }
    catch (err) { setKey(''); setError(err instanceof ApiError && err.status === 401 ? 'That API key was not accepted.' : message(err)); }
    finally { setBusy(false); }
  }
  return (
    <form className="login" onSubmit={submit}>
      <h1>Notifications</h1>
      <p>Sign in with a tenant API key. It stays in this tab only.</p>
      <label htmlFor="key">API key</label>
      <input id="key" type="password" autoComplete="off" placeholder="ntf_live_…" value={value} onChange={(e) => setValue(e.target.value)} />
      <ErrorBox text={error} />
      <button disabled={!value.trim() || busy}>{busy ? 'Checking…' : 'Sign in'}</button>
    </form>
  );
}

function Overview() {
  const [hours, setHours] = useState(24);
  const { data, error } = useLoad(() => api<Stats>(`/v1/stats?hours=${hours}`), [hours], 10_000);
  return (
    <section>
      <div className="row">
        <h2>Overview</h2>
        <select aria-label="Time range" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          <option value={1}>Last hour</option><option value={24}>Last 24 hours</option><option value={168}>Last 7 days</option>
        </select>
      </div>
      <ErrorBox text={error} />
      {!data ? <p className="muted">Loading…</p> : (
        <>
          <div className="cards">
            {statuses.map((s) => <div key={s} className={`card ${s}`}><span>{data.notifications[s]}</span><small>{s}</small></div>)}
          </div>
          <h3>Delivery attempts by channel</h3>
          {data.attempts.length === 0 ? <p className="muted">No attempts in this period.</p> : (
            <table><thead><tr><th>Channel</th><th>Result</th><th className="num">Count</th></tr></thead>
              <tbody>{data.attempts.map((a) => <tr key={a.channel + a.status}><td>{a.channel}</td><td><Badge status={a.status} /></td><td className="num">{a.count}</td></tr>)}</tbody></table>
          )}
        </>
      )}
    </section>
  );
}

function Log() {
  const [status, setStatus] = useState<Status | ''>('');
  const [rows, setRows] = useState<LogRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async (before: string | null, replace: boolean) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: '25', ...(status ? { status } : {}), ...(before ? { before } : {}) });
      const page = await api<{ notifications: LogRow[]; nextBefore: string | null }>(`/v1/notifications?${qs}`);
      setRows((prev) => (replace ? page.notifications : [...prev, ...page.notifications]));
      setNext(page.nextBefore);
      setError('');
    } catch (e) { setError(message(e)); } finally { setLoading(false); }
  }, [status]);
  useEffect(() => { void load(null, true); }, [load]);

  return (
    <section>
      <div className="row">
        <h2>Notifications</h2>
        <select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as Status | '')}>
          <option value="">All statuses</option>{statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <ErrorBox text={error} />
      <table>
        <thead><tr><th>Created</th><th>Type</th><th>Status</th><th>Channels</th><th className="num">Attempts</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="clickable" tabIndex={0} onClick={() => setSelected(r.id)} onKeyDown={(e) => e.key === 'Enter' && setSelected(r.id)}>
              <td>{when(r.createdAt)}</td><td>{r.type}{r.digestCount > 1 && <small className="muted"> ×{r.digestCount}</small>}</td>
              <td><Badge status={r.status} /></td><td>{r.channels.join(', ')}</td><td className="num">{r.attempts}</td>
            </tr>
          ))}
          {!loading && rows.length === 0 && <tr><td colSpan={5} className="muted">No notifications yet.</td></tr>}
        </tbody>
      </table>
      {loading && <p className="muted">Loading…</p>}
      {next && !loading && <button onClick={() => void load(next, false)}>Load more</button>}
      {selected && <DetailPanel id={selected} onClose={() => setSelected(null)} onChanged={() => void load(null, true)} />}
    </section>
  );
}

function DetailPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, reload } = useLoad(() => api<Detail>(`/v1/notifications/${id}`), [id]);
  return (
    <aside className="panel" aria-label="Notification detail">
      <div className="row"><h3>Notification</h3><button className="link" onClick={onClose}>Close</button></div>
      <ErrorBox text={error} />
      {data && (
        <>
          <p><code>{data.id}</code></p>
          <p><Badge status={data.status} /> {data.type} · {data.attempts} attempt{data.attempts === 1 ? '' : 's'}</p>
          <table><thead><tr><th>When</th><th>Channel</th><th>Result</th></tr></thead>
            <tbody>{data.deliveryAttempts.map((a, i) => (
              <tr key={i}><td>{when(a.attemptedAt)}</td><td>{a.channel}</td><td><Badge status={a.status} />{a.error && <small className="muted"> {a.error}</small>}</td></tr>
            ))}{data.deliveryAttempts.length === 0 && <tr><td colSpan={3} className="muted">No attempts yet.</td></tr>}</tbody></table>
          {data.status === 'failed' && <ReplayButton id={id} onDone={() => { reload(); onChanged(); }} />}
        </>
      )}
    </aside>
  );
}

function ReplayButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function replay() {
    setBusy(true);
    try {
      await api(`/v1/notifications/${id}/replay`, { method: 'POST' });
      setError(''); onDone();
      setTimeout(onDone, 1500); // the worker usually finishes within a second; refresh again to show the outcome
    }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <><button disabled={busy} onClick={() => void replay()}>{busy ? 'Replaying…' : 'Replay'}</button><ErrorBox text={error} /></>;
}

function DeadLetters() {
  const { data, error, reload } = useLoad(() => api<{ notifications: Array<{ id: string; type: string; attempts: number; failedAt: string }> }>('/v1/dead-letters'), []);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section>
      <div className="row"><h2>Dead letters</h2><button className="link" onClick={reload}>Refresh</button></div>
      <p className="muted">Notifications whose delivery was abandoned: a permanent error, or all retries used up. Replay re-queues one.</p>
      <ErrorBox text={error} />
      {!data ? <p className="muted">Loading…</p> : (
        <table><thead><tr><th>Failed</th><th>Type</th><th className="num">Attempts</th><th /></tr></thead>
          <tbody>
            {data.notifications.map((n) => (
              <tr key={n.id}><td>{when(n.failedAt)}</td><td>{n.type}</td><td className="num">{n.attempts}</td>
                <td className="actions"><button className="link" onClick={() => setSelected(n.id)}>Details</button></td></tr>
            ))}
            {data.notifications.length === 0 && <tr><td colSpan={4} className="muted">Nothing here. All deliveries are healthy.</td></tr>}
          </tbody></table>
      )}
      {selected && <DetailPanel id={selected} onClose={() => setSelected(null)} onChanged={reload} />}
    </section>
  );
}

function Keys() {
  const { data, error, reload } = useLoad(() => api<{ apiKeys: ApiKeyRow[] }>('/v1/api-keys'), []);
  const [fresh, setFresh] = useState('');
  const [actionError, setActionError] = useState('');
  async function create() {
    try { const k = await api<{ key: string }>('/v1/api-keys', { method: 'POST' }); setFresh(k.key); setActionError(''); reload(); }
    catch (e) { setActionError(message(e)); }
  }
  async function revoke(id: string) {
    if (!window.confirm('Revoke this key? Anything still using it will stop working.')) return;
    try { await api(`/v1/api-keys/${id}`, { method: 'DELETE' }); setActionError(''); reload(); }
    catch (e) { setActionError(message(e)); }
  }
  return (
    <section>
      <div className="row"><h2>API keys</h2><button onClick={() => void create()}>Create key</button></div>
      <ErrorBox text={error || actionError} />
      {fresh && (
        <Notice onDismiss={() => setFresh('')}>
          Copy this key now; it cannot be shown again.<br /><code className="key">{fresh}</code>
          <button className="link" onClick={() => void navigator.clipboard?.writeText(fresh)}>Copy</button>
        </Notice>
      )}
      {!data ? <p className="muted">Loading…</p> : (
        <table><thead><tr><th>Key ID</th><th>Created</th><th>Status</th><th /></tr></thead>
          <tbody>{data.apiKeys.map((k) => (
            <tr key={k.id}><td><code>{k.id.slice(0, 8)}</code></td><td>{when(k.createdAt)}</td>
              <td>{k.revokedAt ? <Badge status="revoked" /> : <Badge status="active" />}</td>
              <td className="actions">{!k.revokedAt && <button className="link danger" onClick={() => void revoke(k.id)}>Revoke</button>}</td></tr>
          ))}</tbody></table>
      )}
    </section>
  );
}

function Notice({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return <div className="notice" role="status">{children}<button className="link" onClick={onDismiss}>Dismiss</button></div>;
}
