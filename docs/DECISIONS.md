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
