// Sends N real emails through a running notification-service (started with EMAIL_PROVIDER=resend) and records
// how many were delivered and how long each took from request to `delivered`. No dependencies; Node 18+.
//
//   $env:BASE_URL="http://localhost:3000"; $env:API_KEY="<your tenant key>"; $env:TO_EMAIL="<your own address>"; node scripts/evidence/send-real-emails.mjs 5
//
// Output (JSON) goes to stdout; redirect it into docs/evidence/email/. The key and address are read from the environment only.
const { BASE_URL = 'http://localhost:3000', API_KEY, TO_EMAIL } = process.env;
const n = Number(process.argv[2] || 5);
if (!API_KEY || !TO_EMAIL) { console.error('Set API_KEY and TO_EMAIL (your own address; Resend test domains only deliver to the account owner).'); process.exit(1); }
const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const call = async (method, path, body) => {
  const r = await fetch(BASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const user = await call('PUT', '/v1/users/evidence-email', { email: TO_EMAIL });
if (user.status !== 200) { console.error('could not upsert user', user.status); process.exit(1); }

const results = [];
for (let i = 1; i <= n; i++) {
  const t0 = Date.now();
  const sent = await call('POST', '/v1/notifications', {
    userId: user.json.id, type: 'evidence', channels: ['email'],
    payload: { subject: `Evidence email ${i}/${n}`, body: `<p>Real delivery test ${i} of ${n}</p>` },
  });
  if (sent.status !== 201) { results.push({ i, ok: false, reason: `send ${sent.status}` }); continue; }
  let status = 'queued', ms = null;
  while (Date.now() - t0 < 60_000) {
    const got = await call('GET', `/v1/notifications/${sent.json.id}`);
    status = got.json.status;
    if (status === 'delivered' || status === 'failed') { ms = Date.now() - t0; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  results.push({ i, ok: status === 'delivered', status, ms });
}
const ok = results.filter((r) => r.ok);
const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
console.log(JSON.stringify({ when: new Date().toISOString(), baseUrl: BASE_URL, requested: n, delivered: ok.length, failed: n - ok.length,
  latencyMs: { min: lat[0] ?? null, median: lat[Math.floor(lat.length / 2)] ?? null, max: lat.at(-1) ?? null }, results }, null, 2));
