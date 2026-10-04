# Real-Time Notification Service

Multi-tenant notification API with durable PostgreSQL persistence, BullMQ delivery, and email templates.

## Requirements

- Node.js 20+
- Docker Compose

## Local setup

```sh
docker compose up -d
cp .env.example .env
npm install
npm run db:migrate
npm run provision:tenant -- "My first app"
npm run dev
```

Provisioning prints a one-time `ntf_live_...` key. Save it securely; the database stores only its SHA-256 hash. The API currently accepts `POST /v1/notifications` with `Authorization: Bearer <key>` and JSON `{ "userId": "<tenant user UUID>", "type": "reminder", "payload": {} }`.

Create or update tenant users with `PUT /v1/users/:externalUserId` and `{ "email": "person@example.com" }`. Templates are created with `POST /v1/templates` using `{ "name": "welcome", "subject": "Hi {{name}}", "body": "<p>Hello {{name}}</p>", "variables": ["name"] }`; `GET /v1/templates` lists only the authenticated tenant's templates. A notification may specify `templateName` and `variables` in addition to `userId`, `type`, and `payload`. Missing required template variables return `422`; HTML body substitutions are escaped.

Run `npm run dev` for the API and `npm run worker` in a second terminal. Redis and PostgreSQL are provided by `docker compose up -d`. The default email channel is a mock. Set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and `EMAIL_FROM` in `.env` to enable Resend. Tests use the mock channel.

```sh
npm run lint
npm test
npm run build
```

## Real-time delivery and inbox

Add `"channels": ["in_app"]` (or `["email", "in_app"]`; default `["email"]`) to a notification to deliver it in-app. The notification row is the durable inbox entry; the worker also publishes it over Redis pub/sub so every API instance can push it to that user's open sockets.

1. Set `STREAM_TOKEN_SECRET` (32+ chars) in `.env`.
2. Your backend mints a one-hour token for its end user: `POST /v1/users/:externalUserId/stream-token` with the API key returns `{ "token", "expiresAt" }`.
3. The browser opens `ws://host/stream?token=...`. It first receives `{type:"inbox", notifications:[...]}` (latest 50, newest first, including `readAt`) and then `{type:"notification", notification:{...}}` live. Send `{type:"read", id}` to mark one read; the reply is `{type:"read", id, ok}`.
4. Backends can also use `GET /v1/users/:externalUserId/inbox` and `POST /v1/users/:externalUserId/inbox/:id/read` (204).

Open `/demo` in a browser, paste a token, and send notifications to watch them appear live and survive a refresh. The token is in the query string, so request logs redact it.

## API response

Successful creation returns `201` with `id`, `status: "queued"`, and `createdAt`. Errors use `{ "error": { "code": "...", "message": "..." } }`; malformed input returns `400`, missing/invalid credentials `401`, and a user not found within the tenant `422`.

## Preferences, quiet hours and digests

- `GET/PUT /v1/users/:externalUserId/preferences`. PUT replaces the whole set: `{ "preferences": [{ "channel": "email", "type": "promo", "enabled": false }, { "channel": "*", "type": "*", "quietHours": { "start": "22:00", "end": "07:00", "timezone": "Asia/Kolkata" } }] }`. `channel` is `email`, `in_app` or `*`; `type` is a notification type or `*`. The most specific row decides `enabled`; quiet hours come from the most specific row that defines them.
- An opted-out channel is skipped (recorded as a `skipped` attempt). If nothing was delivered the notification ends as `suppressed`.
- **Quiet hours delay, they never drop:** during the window the notification waits (status `queued`, `deliverAfter` set) and is delivered when the window ends. Opted-out channels are not delayed, they are skipped.
- **Digests:** add `"digestKey": "comments:post-42"` (and optionally `"digestWindowSeconds"`, 10 to 86400, default 300) to a notification. The first one waits out the window; every other notification for that user and key that arrives meanwhile is absorbed (`batched`) and one combined notification goes out ("3 new comment notifications", or your template with an extra `{{count}}` variable). In-app inbox items carry `count`. A lone notification is sent normally.

## Dashboard API

`GET /v1/stats?hours=24` (counts by status and by channel/attempt status), `GET /v1/notifications?status=&limit=&before=` (log, newest first, `nextBefore` cursor), and API keys: `GET /v1/api-keys`, `POST /v1/api-keys` (returns the plaintext key once), `DELETE /v1/api-keys/:id` (`409` for the last active key). Plus the dead-letter endpoints below.

## Reliability

**Delivery guarantee: at-least-once processing, effectively-once delivery.** A notification is never dropped by a crash, restart or provider outage, and a crash can at worst cause a repeat *attempt*, which is deduplicated so the recipient sees it once. Three layers provide this:

1. **Claim and skip:** the worker claims a notification (`queued`/`sending` to `sending`) and records a `sent` attempt per channel. Retries and crash redeliveries skip channels already sent.
2. **Provider idempotency key:** every email is sent with `Idempotency-Key: <notificationId>:email`, so a crash between "provider accepted" and "we recorded it" cannot produce a second email on providers that honour the header (Resend does, for 24 hours). In-app items are keyed by notification id, which the client dedupes on.
3. **Idempotent API:** send `Idempotency-Key: <your key>` on `POST /v1/notifications`. A repeated call returns the original notification with `200` and `Idempotent-Replayed: true`; the same key with a different body returns `422 IDEMPOTENCY_KEY_REUSED`.

**Retries:** transient failures are retried up to 5 attempts with exponential backoff (1s, 2s, 4s, ...) and 50% jitter. Permanent failures (no recipient email, missing template, provider 4xx other than 408/429) skip retries.

**Dead letters:** a notification that fails permanently or exhausts its attempts ends as `failed`. `GET /v1/dead-letters` lists them, `GET /v1/notifications/:id` shows status and every delivery attempt with its error, and `POST /v1/notifications/:id/replay` re-queues one (`202`; `409` if it is not failed).

**Crashes and the enqueue gap:** a killed worker's job is redelivered by BullMQ after its lock expires, and the next worker takes over the half-sent notification. Notifications committed but never enqueued (the `503` case, or lost Redis data) are re-enqueued by a sweeper that runs in every worker (`queued`/`sending` and untouched for 60s; re-adding is a no-op while a job is live). Workers shut down gracefully on SIGTERM, finishing in-flight jobs first.

**Rate limiting:** each tenant has a Redis token bucket (`RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST`) shared by all API instances. Over the limit returns `429` with `Retry-After`. If Redis is unreachable the limiter fails open.

`tests/chaos.integration.test.ts` kills a real worker process mid-send with 20 notifications in flight and asserts all 20 are delivered, none lost, none sent twice.

## Known limitations

- Exactly-once delivery is not claimed. A provider without idempotency keys could repeat an email after a crash in the window between acceptance and our record; this is the usual at-least-once trade-off.
- Retries are per notification, not per channel: a failing channel is retried alongside the others, but channels that already succeeded are skipped.
- Stream gateways have no heartbeat or per-connection limit yet, and stream tokens cannot be revoked before they expire.
- Notifications are committed before enqueueing; if enqueueing fails the API returns `503` with the saved ID, and the client's retry (same Idempotency-Key) or the sweeper recovers it.
