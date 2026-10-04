# Design decisions

## Phase 1: foundation

- **Fastify + Drizzle:** Fastify provides a small typed HTTP surface; Drizzle keeps the PostgreSQL schema and queries close to TypeScript while still using explicit SQL migrations.
- **One API key per initial tenant credential:** Generate 32 random bytes with a `ntf_live_` prefix and show plaintext only once. Persist SHA-256 only; authenticate by hash lookup and constant-time digest comparison.
- **Tenant identity comes from authentication:** Request bodies cannot select a tenant. User lookup and notification insertion are constrained by the tenant ID attached to the authenticated API key.
- **Queued status before a queue exists:** New notifications start in `queued` so the API contract and persisted lifecycle can remain stable when BullMQ is added in Phase 2. In Phase 1 this means persisted for later processing, not yet asynchronously delivered.
- **Notification payload is JSON:** The API accepts an opaque JSON object and leaves channel-specific interpretation to later phases.

## Planned architecture decisions

- **Why a queue:** A durable job queue decouples API acceptance from provider latency, smooths bursts, and permits retrying failed delivery work without blocking requests.
- **Why Redis pub/sub for WebSocket fan-out:** It broadcasts real-time events among gateway instances with a small operational footprint; PostgreSQL remains the durable inbox source for reconnects.
- **Why at-least-once delivery:** Durable jobs and retries prevent silent loss across worker crashes. A stable notification identity and idempotent handling contain duplicates, yielding effectively-once user-visible behavior where channel/provider support allows it.

## Phase 2: queue and email

- **Post-commit enqueue gap:** The API commits a notification before adding its ID to BullMQ. If enqueueing fails, it returns `503` with the notification ID and leaves the row `queued`; it logs this condition. A Phase 4 sweeper or transactional outbox will recover it.
- **Queue job payload:** BullMQ jobs contain only the persisted notification ID. Workers reload recipient, template, variables, and payload from PostgreSQL.
- **Queue retry policy:** Phase 2 uses BullMQ defaults (one processing attempt by default); application retries, a dead-letter queue, and rate limiting are deferred to Phase 4. A provider failure is recorded and transitions the notification to `failed`.
- **Email channel selection:** The mock channel is the default. Resend is enabled only when `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and `EMAIL_FROM` are present; provider-specific behavior stays in the adapter.
- **Worker idempotency:** Workers claim with a conditional `queued` to `sending` update. Missing returned rows, including already delivered notifications, are skipped.

## Phase 3: real-time and inbox

- **The `notifications` row is the inbox:** In-app notifications are persisted at creation, so reconnect replay is a query, not a separate store. Redis pub/sub is only the live mirror and may drop messages without loss of data.
- **Subscribe before backlog:** A socket joins its user's pub/sub topic first, then reads the inbox, so nothing published between the two is missed. The cost is a possible duplicate, which clients drop by notification `id`.
- **Per-user topics with per-instance refcount:** An instance subscribes to `user:{id}` only while it holds a socket for that user, avoiding every instance receiving every tenant's traffic. One subscriber connection per instance, because a subscribed Redis client cannot issue other commands.
- **Short-lived HMAC tokens, not JWT:** The tenant backend (which holds the API key) mints a one-hour token containing user and tenant IDs, signed with `STREAM_TOKEN_SECRET` via `node:crypto`. Browsers never see an API key, and no JWT dependency is needed. Tokens cannot be revoked before expiry.
- **Channels per notification:** `channels` (`email`, `in_app`; default `email`) is stored on the notification. Each channel gets its own `delivery_attempts` row; any channel failure marks the notification `failed` until Phase 4 retries per channel.
- **Read state is a nullable `read_at`:** Marking read uses `coalesce(read_at, now())`, so repeated acknowledgements are idempotent and keep the first read time. Read events are not broadcast to a user's other tabs.
