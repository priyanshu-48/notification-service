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

## Current boundary

Notifications are committed before enqueueing. If enqueueing fails, the API returns `503` with the saved notification ID and leaves its status `queued`; Phase 4 will add recovery through an outbox or sweeper. Phase 3 stream gateways have no heartbeat or per-connection limit yet, and a failed channel marks the whole notification `failed` until Phase 4 adds per-channel retry. Phase 2 uses BullMQ defaults and does not implement application retries, a dead-letter queue, or rate limiting. A worker claims only queued notifications, records each channel attempt, and skips notifications it cannot claim.
