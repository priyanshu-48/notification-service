// k6 load test: sends notifications at a fixed arrival rate, then waits for the worker to drain the queue and reports
// both numbers that matter: how fast the API accepts work (latency) and how fast the system actually finishes it (throughput).
//
// Use a fresh tenant for each run: results are computed as deltas over everything the tenant did in the last 24 hours.
//   k6 run -e API_KEY=ntf_live_... -e BASE_URL=http://localhost:3000 -e RATE=100 -e DURATION=60s loadtest/notifications.js
//
// Run it against a tenant whose rate limit is raised (RATE_LIMIT_PER_MINUTE / RATE_LIMIT_BURST), or the limiter will answer 429.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const KEY = __ENV.API_KEY;
const USERS = Number(__ENV.USERS || 50);
const RATE = Number(__ENV.RATE || 100); // notifications per second
const DURATION = __ENV.DURATION || '60s';
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const accepted = new Counter('notifications_accepted');

export const options = {
  scenarios: {
    send: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 50, maxVUs: 500 },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:send}': ['p(95)<500'],
    checks: ['rate>0.99'],
  },
  teardownTimeout: '600s',
};

const terminal = (stats) => stats.notifications.delivered + stats.notifications.failed + stats.notifications.suppressed;
const inFlight = (stats) => stats.notifications.queued + stats.notifications.sending + stats.notifications.batched;
const getStats = () => http.get(`${BASE}/v1/stats?hours=24`, { headers }).json();

export function setup() {
  if (!KEY) throw new Error('Set -e API_KEY=ntf_live_...');
  for (let i = 0; i < USERS; i++) {
    const res = http.put(`${BASE}/v1/users/load-${i}`, JSON.stringify({ email: `load-${i}@example.test` }), { headers });
    if (res.status !== 200) throw new Error(`Could not create user ${i}: ${res.status} ${res.body}`);
  }
  const before = getStats();
  return { startedAt: Date.now(), baselineTerminal: terminal(before) };
}

export default function () {
  const res = http.post(
    `${BASE}/v1/notifications`,
    JSON.stringify({ externalUserId: `load-${Math.floor(Math.random() * USERS)}`, type: 'loadtest', payload: { title: 'Load test', n: __ITER }, channels: ['email', 'in_app'] }),
    { headers: { ...headers, 'Idempotency-Key': `lt-${__VU}-${__ITER}-${Date.now()}` } },
  );
  const ok = check(res, { 'accepted (201)': (r) => r.status === 201 });
  if (ok) accepted.add(1);
}

// Wait for the worker to finish everything that was accepted, then compute end-to-end throughput.
export function teardown(data) {
  let quiet = 0;
  let stats = getStats();
  while (quiet < 3) {
    if (Date.now() - data.startedAt > 540000) break;
    sleep(1);
    stats = getStats();
    quiet = inFlight(stats) === 0 ? quiet + 1 : 0;
  }
  const done = terminal(stats) - data.baselineTerminal;
  const seconds = (Date.now() - data.startedAt) / 1000;
  console.log(JSON.stringify({
    completed: done, failed_total: stats.notifications.failed, seconds: Math.round(seconds),
    end_to_end_per_minute: Math.round((done / seconds) * 60), still_in_flight: inFlight(stats),
  }));
}
