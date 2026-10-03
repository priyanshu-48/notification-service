# Real-Time Notification Service

Phase 1 foundation for a multi-tenant notification API. The API validates and persists notifications; the queue and delivery worker are added in a later phase.

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

The tenant user must currently exist in the database. User provisioning and notification read APIs are outside Phase 1. The request's user UUID is checked against the authenticated tenant, and tenant identity is never accepted from the body.

```sh
npm run lint
npm test
npm run build
```

## API response

Successful creation returns `201` with `id`, `status: "queued"`, and `createdAt`. Errors use `{ "error": { "code": "...", "message": "..." } }`; malformed input returns `400`, missing/invalid credentials `401`, and a user not found within the tenant `422`.

## Current boundary

No queue or delivery occurs yet. `queued` means accepted and persisted. API-key rotation can be done by issuing a second tenant key and revoking the old hash administratively; a public key management API is not part of this phase.
