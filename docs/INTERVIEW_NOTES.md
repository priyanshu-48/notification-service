# Interview notes

Plain-language walkthrough of the parts that are easiest to be asked about. Line numbers are for commit `2198e13` (the code these notes were written against); re-check them if the files change.

The one-sentence version: the API writes a notification row to Postgres, puts only its id on a queue, and a worker claims the row, sends it per channel, and records each attempt. Postgres is the truth, the queue is a delivery mechanism, and every step is safe to run twice.

## 1. The claim-and-skip state machine
- **Where:** `src/state-machine.ts:10-17` (legal transitions), `:32-37` (`claimNotification`), `src/worker-service.ts:79-139` (`processNotification`).
- **What:** a notification is `queued -> sending -> delivered | failed`, plus `batched` (absorbed into a digest) and `suppressed` (everything opted out). Illegal moves throw (`assertLegalTransition`, `:19`).
- **Claim:** a single conditional `UPDATE ... WHERE status IN ('queued','sending')` (`:33-35`). If the row is already `delivered` or `failed`, nothing is updated, the worker gets no row back and returns (`worker-service.ts:81-82`). That makes a duplicate or late job harmless.
- **Why it also claims from `sending`:** the comment at `state-machine.ts:30-31`. A queue job is unique per notification and BullMQ only redelivers after the previous worker's lock expired, so seeing `sending` means that worker died.
- **Skip:** before sending, the worker reads attempts already `sent` or `skipped` for this notification (`worker-service.ts:87-89`) and skips those channels (`:97`). So if email succeeded and in-app failed, a retry only repeats in-app.
- **Honest limit:** the order is "send, then record the attempt" (`:108-113`). A crash between the provider accepting the email and the `sent` row being written means the retry sends again. The defence is the provider idempotency key `<notificationId>:email` (`:60`), which Resend honours; the mock channel in tests records it. In-app has no equivalent, so the client dedupes by id. This is why the claim is "at-least-once with deduplication", not "exactly-once".

## 2. Idempotency keys and request fingerprinting
- **Where:** `src/app.ts:58-62` (`canonicalJson`), `:134-165` (create flow), unique index `(tenant_id, idempotency_key)` in `src/db/schema.ts`.
- **What:** `Idempotency-Key` header, max 255 chars (`:66`). The body is canonicalised (object keys sorted, so key order does not matter) and SHA-256 hashed (`:136`). Insert uses `ON CONFLICT DO NOTHING` on `(tenant, key)` (`:146`).
- **If the insert hit a conflict:** load the existing row (`:151-152`). Same hash -> return the original notification (replay-safe). Different hash -> 422, the key was reused with a different request (`:154`).
- **Edge:** if the original is still `queued`, the first call may have failed after commit and before enqueue (the 503 path at `:166`), so the retry re-adds the job. That is safe because the BullMQ `jobId` is the notification id, so adding twice is a no-op.
- **Concurrency:** two simultaneous first requests: the unique index decides the winner at the database, no application lock.

## 3. The sweeper
- **Where:** `src/sweeper.ts:9-16`, scheduled every 30 s in `src/worker-runtime.ts:22`.
- **Problem it solves:** the notification is committed to Postgres and then enqueued in a separate system. If enqueue fails, Redis loses data, or a job exhausts BullMQ's stalled limit, the row would sit in `queued` forever.
- **How:** find rows in `queued` or `sending` not updated for 60 s (limit 100 per pass) and re-enqueue them. Re-enqueueing is idempotent (same `jobId`), so running it on every worker is safe. It keeps a deferred row's remaining delay (`:14`).
- **Why not a transactional outbox:** idempotent enqueue plus a reconciler gives the same safety with less machinery. The trade-off is up to ~90 s recovery latency instead of near-immediate.

## 4. Quiet hours delay, not drop
- **Where:** `src/worker-service.ts:104-105` (decide), `:129-132` (defer), `:141-152` (BullMQ handler), `src/state-machine.ts:40-44` (`deferNotification`).
- **What:** if every remaining channel is inside the user's quiet hours, the row goes back to `queued` with a later `deliverAfter`, and the attempt counter is refunded (`:42`) because nothing was tried. The handler then moves the live job to BullMQ's delayed set and throws `DelayedError` so BullMQ neither completes nor fails it (`:149-150`).
- **Recovery:** if the delayed job is lost, the sweeper recreates it with the remaining delay.

## 5. Why the socket subscribes before reading the inbox
- **Where:** `src/realtime.ts:55-65`, comment at `:63`.
- **Race it avoids:** read backlog first, then subscribe -> anything published in between is in neither. Subscribing first and reading second can only produce a duplicate (item appears in both), and the client dedupes by id (SDK `NotificationStream`).
- **Related details:** listeners are attached synchronously (`:42`) so early client messages are not lost; subscriptions are per user and reference-counted per instance (`:28`, `:49-53`); the inbox is "notifications with a `sent` in_app attempt", so a user who was offline gets them on connect even though Redis pub/sub has no memory.

## 6. The fail-open rate limiter
- **Where:** `src/rate-limit.ts:23-47` (Lua token bucket), `src/app.ts:93-98` (use), `src/server.ts:17` (own connection).
- **What:** token bucket per tenant in one atomic Lua script, using Redis `TIME` so API instances' clocks do not matter. Defaults 600/min, burst 100 (`src/server.ts:19-20`). Over the limit -> 429 with `Retry-After`.
- **Fail-open:** if Redis is down, `take()` rejects, the code logs a warning and lets the request through (`app.ts:95`). A dedicated connection with `maxRetriesPerRequest: 1, enableOfflineQueue: false` makes that failure fast instead of queueing forever. Reasoning: the limiter protects the service, so it must not be what takes it down. Trade-off: during a Redis outage there is no rate limiting (and the queue is down anyway).

## Likely interviewer questions

1. **Is this exactly-once?** No. It is at-least-once processing with deduplication: conditional claim, per-channel attempt records, provider idempotency key, API idempotency key, deterministic job id. The small window described in section 1 is why in-app items are deduped by the client.
2. **What happens if a worker dies mid-send?** BullMQ redelivers after the lock expires (`maxStalledCount` 3, `src/worker-runtime.ts:15`); the claim accepts `sending`; sent channels are skipped. `tests/chaos.integration.test.ts` kills a real worker process with 20 in flight and checks every notification delivered once. See `docs/evidence/` for the re-run results.
3. **What if Redis loses everything?** Postgres still has every row. The sweeper re-enqueues stuck rows. Live WebSocket pushes in that window are lost but the inbox replays from Postgres.
4. **How do retries work?** 5 attempts, exponential backoff starting at 1 s with 0.5 jitter (`src/queue.ts:7-9`). A permanent error (bad address, missing template) skips retries and goes straight to `failed`. `failed` is the dead-letter set; `POST /v1/notifications/:id/replay` moves it back to `queued`. Tests use a shortened backoff, so the real timing values are configuration, not something the tests clock.
5. **How is multi-tenancy enforced?** The tenant comes from the hashed API key, never the body; every query includes `tenant_id`. Some isolation is tested (cross-tenant send, template list, replay, erase); see the evidence doc for what is and is not covered.
6. **Why a queue at all, and why Postgres as truth?** Sends must not block the request or depend on a provider being up; the DB row is what makes retries, audit, dashboards and recovery possible.
7. **How would it scale?** Add API instances (Redis pub/sub fans out, rate limit is shared) and workers (concurrency 10 each). Bottlenecks I would watch: Postgres write rate, the single Redis, and the sweeper's 100-row batches. The numbers I have are laptop benchmarks only.
8. **What are the benchmark limits?** One laptop, Postgres on the same machine, mock email channel (no network), single run per row in the original README, k6 competing for the same CPU. They show the internal pipeline's capacity, not real-provider throughput.
9. **What is not implemented or tested?** The Resend adapter has 0% unit coverage and I have not shown real emails in the repo (see evidence doc); no auth beyond API keys; no per-channel provider failover; no multi-region.
10. **Did you write this yourself?** The project was built with an AI coding assistant (Claude Code) and committed under my name. I directed the design (phases, guarantees, trade-offs) and I can walk through every mechanism above and the decision records in `docs/DECISIONS.md`. Give a straight answer about what you decided versus what was generated, and be ready to modify the code live.
