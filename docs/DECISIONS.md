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

## Phase 4: reliability

- **At-least-once with deduplication, not exactly-once:** Exactly-once across a worker, a database and an external provider is impossible without provider cooperation. Instead, each step is made safe to repeat: claims are conditional updates, `sent` attempts are skipped on retry, and the provider gets a stable `Idempotency-Key` (`<notificationId>:email`). The only residual duplicate window is a provider that ignores the key.
- **The queue job is unique per notification:** `jobId` is the notification id, so adding it again while a job is live is a no-op. That makes client retries, the sweeper and replays safe to repeat, and is why a worker may claim from `sending` (BullMQ only redelivers after the previous worker's lock expired). Finished jobs are removed so a replay can enqueue the same id again.
- **Postgres is the source of truth for attempts:** The attempt counter lives on the notification row, not in BullMQ, so crash redeliveries count and the retry limit holds even when a job is redelivered by the stalled-job checker. BullMQ's own attempt count is set to the same limit only to drive backoff.
- **Retry by resetting to `queued` and throwing:** After a retryable failure the row returns to `queued` and the job throws, letting BullMQ schedule the backoff. The final attempt does not throw; it moves the row to `failed` so BullMQ never holds a failed job the database disagrees with.
- **Dead-letter set is a database status:** `failed` is queryable per tenant and survives Redis loss, unlike a BullMQ failed set. Replay is a conditional `failed` to `queued` update, so double-clicking replay enqueues once.
- **Permanent versus transient errors:** `PermanentDeliveryError` (missing email or template, provider 4xx except 408/429) skips retries. Everything else is treated as transient, because retrying a permanent error wastes attempts but dropping a transient one loses a notification.
- **Idempotency fingerprint:** The key is unique per tenant, and the request body is hashed (key-order independent). Reusing a key with a different body is an error rather than a silent return of an unrelated notification. A repeat of a notification still `queued` re-attempts the enqueue, healing the `503` gap.
- **Sweeper instead of a transactional outbox:** The enqueue gap is closed by a periodic query for old `queued`/`sending` rows, run by every worker. It is simpler than an outbox and correct because enqueueing is idempotent; the cost is up to about a minute of added latency in the rare gap case.
- **Token bucket in a Redis Lua script:** Atomic, shared across instances, and uses Redis `TIME` so instance clock skew is irrelevant. The limiter uses its own fail-fast connection and fails open, because an outage of the limiter should not become an outage of the API.

## Phase 5: preferences, digests, dashboard API

- **Preferences are applied at delivery time, not send time:** The worker reads them just before each channel, so a change made while a notification is queued or delayed is honoured. `suppressed` is a distinct terminal status: "delivered" would be untrue, and "failed" would put a user's choice in the dead-letter set.
- **Quiet hours defer through the queue:** The worker puts the row back to `queued` with `deliverAfter`, refunds the attempt, and moves the live BullMQ job to the delayed set (`moveToDelayed` plus `DelayedError`). The sweeper re-creates a lost job with its remaining delay. The window end is computed from the current local clock, so a DST change inside the window can shift it by an hour.
- **Digests need no separate table or timer:** The first notification of a window carries a delayed job. When it runs, one `UPDATE` absorbs every other queued notification for that user and key. A notification arriving at that exact moment either joins this digest or starts the next one; none can be stranded. Absorbed members stay `batched` while the leader is failed, so replaying the leader re-sends the whole digest, and they finish with it when it is delivered.
- **The inbox shows what was delivered in-app:** It is now defined by a `sent` in-app attempt instead of "has the in_app channel", so notifications held by quiet hours or a digest window do not appear early, and digest members appear only through their leader.
- **Dashboard auth reuses API keys:** The dashboard calls the same tenant-scoped API with a pasted API key rather than adding a second login system. Keys can be created and revoked, but the last active key cannot be revoked, so a tenant cannot lock itself out.
- **No `last_used` on API keys:** It would add a database write to every request. Add it with a throttled update if the dashboard needs it.

## Phase 6a: client SDK

- **Two classes, split by trust:** `NotificationClient` needs the API key and belongs on a server; `NotificationStream` runs where users are and only ever holds a one-hour stream token. Splitting them makes it hard to ship the key to a browser by accident.
- **Callers use their own user ids:** `POST /v1/notifications` now accepts `externalUserId` (exactly one of it or `userId`). Otherwise every client would have to store the internal UUID returned by `upsertUser`.
- **`send` always carries an idempotency key:** Generated if the caller gives none, and reused across retries. That is what makes retrying a `POST` safe, including the `503` where the notification was saved but not queued. Only requests that are safe to repeat are retried.
- **`getToken` is a callback, not a token:** Tokens expire after an hour and reconnects are routine, so the stream asks for a fresh one on every connect. Repeated `4401` rejections stop the stream instead of looping.
- **No dependencies, standard WebSocket API:** Uses global `fetch` and `WebSocket` (browsers, extensions, Node 22+); a `WebSocket` class can be injected for older Node. Not published to npm yet.
