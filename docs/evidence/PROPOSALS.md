# Proposals (nothing here has been implemented or run unless it says so)

## A.4 Cover the Resend adapter with a mocked-HTTP test
`src/resend-email-channel.ts` is 0% covered (it is the real third-party adapter). A test needs no network: stub `globalThis.fetch` with `vi.stubGlobal`.
Cases, all against `ResendEmailChannel.send` (`:9-24`) and `createEmailChannel` (`:27-33`):
1. 200 -> resolves; assert URL `https://api.resend.com/emails`, `Authorization: Bearer <key>`, body `{from,to:[addr],subject,html}`, header `Idempotency-Key` equals the message key.
2. 400/401/422 -> rejects with `PermanentDeliveryError` (`:22`).
3. 408, 429, 500, 503 -> rejects with a plain `Error` (transient, retried).
4. No idempotency key -> header absent.
5. `fetch` rejects (timeout/abort) -> propagates as a transient error.
6. `createEmailChannel`: mock by default, Resend with all three env vars, throws if `EMAIL_PROVIDER=resend` lacks a key or from-address.

Expected gain: the file is 33 lines; this should bring it close to 100% of its lines. I will measure the real figure after you approve; I will not quote one before then. It proves the adapter's error classification, not that Resend accepts real mail (see F.1).

## A.5 Tenant-isolation tests worth adding (one new file, `tests/tenant-isolation.integration.test.ts`)
Already covered: cross-tenant send (422), tenant-scoped template list, cross-tenant replay (404), erase scoped to tenant, rate limit per tenant.

Missing, each about 5 lines using the existing two-tenant setup in `phase2.integration.test.ts`:
1. Tenant B `GET /v1/notifications/:id` of A's notification -> 404.
2. Tenant B `GET /v1/notifications` list does not contain A's.
3. Tenant B `GET /v1/dead-letters` and `/v1/stats` exclude A's data.
4. Tenant B inbox/preferences for A's `externalUserId` -> empty or its own user, never A's rows.
5. A stream token minted for A cannot read B's inbox (the token carries `tenantId`; `src/realtime.ts:39`).
6. A revoked API key stops working (check first whether this is already tested).

After these, "multi-tenant with tests for cross-tenant isolation on send, read, list, replay, erase and stream" would be accurate.

## E.2 Coverage in CI
Add after the test step in `.github/workflows/ci.yml`: `npm run test:coverage`, then upload `docs/evidence/tests/coverage/coverage-summary.json` with `actions/upload-artifact@v4`. Optionally fail below a floor (suggest 75%, under the measured 79.84%). Coverage runs the same suite, so it can replace the `npm test` step rather than add a second run.

## F.1 Real email evidence (you run it; I do not touch your keys)
1. Resend account. Verify a sending domain, or use their test sender. `EMAIL_FROM` must be allowed by Resend. Until a domain is verified, Resend only delivers to your own account address.
2. Start Postgres and Redis (`docker compose up -d`), then set these yourself in PowerShell: `DATABASE_URL` (compose Postgres, check the port in `compose.yaml`), `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, `RUN_WORKER=true`. Run `npm run db:migrate` then `npm run dev`. Check `docs/DEPLOY.md` for the exact variable names if anything differs.
3. In another window: `npm run provision:tenant -- evidence` and copy the printed `ntf_live_...` key into `$env:API_KEY` yourself.
4. Set `$env:BASE_URL = "http://localhost:3000"` and `$env:TO_EMAIL` to your own address, then run `node scripts/evidence/send-real-emails.mjs 5 > docs/evidence/email-run.json`.
5. Check your inbox. The JSON has delivered/failed counts and request-to-`delivered` latency per email. It does not print your address.

The script is `scripts/evidence/send-real-emails.mjs`. It is syntax-checked only and has not been run against a service. "Delivered" there means the worker handed the email to Resend and got a 2xx, not that it reached the inbox; the inbox check is the real confirmation.

## F.2 Measure the live Render instance (safe rate)
The free tier is small, so use 2 per second for 60 s and a fresh tenant. Create a tenant on the live database first (see `docs/DEPLOY.md`), then set `API_KEY` yourself.
- Check readiness: `curl.exe https://notification-service-2xde.onrender.com/ready`
- Warm the service first (the first request after idle can take tens of seconds).
- Run the committed k6 script from the repo root:
  `docker run --rm -i -e API_KEY=$env:API_KEY -e BASE_URL=https://notification-service-2xde.onrender.com -e RATE=2 -e DURATION=60s -v "${PWD}/loadtest:/loadtest" grafana/k6 run /loadtest/notifications.js`

The default limit of 600/min is above 2/s, so 429s are not expected. The result measures accepted rate, API p95 (including your internet round trip) and drain time. Save the output under `docs/evidence/live/`.

## F.4 Safe public demo for recruiters
- Use a dedicated demo tenant on the existing deployment with mock email only. Never set `EMAIL_PROVIDER=resend` on a shared demo, so nobody can use it to send mail.
- Rate limits are global env vars today, not per tenant, so a low per-tenant limit for the demo needs a small code change (not made).
- A key can currently also manage API keys (`/v1/api-keys`), so publishing a key needs a read-only/scoped key concept that does not exist yet.
- No-code alternative: a screen recording or GIF in the README, plus the bundled `/demo` page against a local `docker compose up`.

Recommendation: the recording plus the local one-command demo now. Add per-tenant limits and key scopes only if you want a live public demo.
