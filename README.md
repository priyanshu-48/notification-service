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

## API response

Successful creation returns `201` with `id`, `status: "queued"`, and `createdAt`. Errors use `{ "error": { "code": "...", "message": "..." } }`; malformed input returns `400`, missing/invalid credentials `401`, and a user not found within the tenant `422`.

## Current boundary

Notifications are committed before enqueueing. If enqueueing fails, the API returns `503` with the saved notification ID and leaves its status `queued`; Phase 4 will add recovery through an outbox or sweeper. Phase 2 uses BullMQ defaults and does not implement application retries, a dead-letter queue, or rate limiting. A worker claims only queued notifications, records each channel attempt, and skips notifications it cannot claim.
