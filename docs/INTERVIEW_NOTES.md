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

## 7. A bug I found by rehearsing on the real stack (the 415 that came back as a 500)

**The 30-second version.** While rehearsing the demo script against the real service, one call returned 500. The log showed Fastify had rejected the request as "Unsupported Media Type" (a 415), and my error handler only knew how to pass through a 400, so every other client error became a generic 500. I fixed the handler to pass 4xx statuses through, wrote the failing tests first, and fixed the client script separately. The same bug also hid oversized bodies (413).

**Situation.** I had written a PowerShell script (`scripts/demo/demo.ps1`) to drive a screen-recorded demo. I tested it first against a small stub server that I wrote, and it passed in both PowerShell 7 and Windows PowerShell 5.1.

**Problem.** Running it against the real API and worker, Scene 1 failed: `POST /v1/users/maya/stream-token` returned **500**, and the script then crashed on a missing token. The stub could not have caught this, because it only did what I assumed the server did.

**Diagnosis.** The server log said `FastifyError: Unsupported Media Type` and the response was 500, which is contradictory: a 415 had been logged as a server failure. Two separate causes:
1. **Client side.** Windows PowerShell's `Invoke-WebRequest` sends a POST with no body using a form content type (`application/x-www-form-urlencoded`). Fastify has no parser for that, so it raises a 415.
2. **Server side (the real bug).** The error handler (`src/app.ts:103-109`) had a special case for status 400 and nothing else, so every other client error Fastify raises fell through to `500 INTERNAL_ERROR`. That also affected a request body over the 1 MB limit (413), which I found by checking the same class of error and confirmed with a test.

**Fix.**
- **Server:** the handler now passes through any Fastify 4xx status in the API's normal `{ error: { code, message } }` shape: 400 `BAD_REQUEST` (unchanged), 413 `PAYLOAD_TOO_LARGE`, 415 `UNSUPPORTED_MEDIA_TYPE`, and a generic `BAD_REQUEST` with the original status for any other 4xx (`src/app.ts:293-303`, called at `:107`). Real server errors still return 500 and are still logged. I fixed the category, not only the one status that bit me.
- **Client:** the demo script sends `{}` as JSON for bodyless POSTs (`scripts/demo/demo.ps1`, the `Call` function).
- **Docs:** the OpenAPI error section now lists 413 and 415, and says a bodyless POST should send no `Content-Type` or `{}` as JSON (`docs/openapi.yaml`).

**How I tested it.** Red-green: I wrote the tests first and watched the 415 and 413 ones fail with 500, then pass after the fix (`tests/app.test.ts:66-93`). A third test checks that malformed JSON still returns 400 with the same message, so the old behaviour is protected. The full suite passed afterwards (119 tests, 1 opt-in skipped) along with lint, build and the OpenAPI tests.

**Why it matters.** A 500 says "the server is broken": it triggers alerts, makes clients retry as if it might work next time, and hides the real cause from the caller. A 4xx says "your request was wrong, change it". Reporting the wrong class is a correctness problem for every client of the API, not cosmetic.

**What I would say I learned.**
- A test double mirrors your assumptions; the rehearsal on the real stack found what the stub could not.
- Handle error categories (4xx versus 5xx), not individual status codes.
- When one case of a bug appears, check the siblings: that is how the 413 turned up.

**Limits, said honestly.** I found it by rehearsing, not from a user report, and it was low severity (nothing was lost). The catch-all for "any other 4xx" has no test of its own. The 413 test sends a 1.1 MB body in memory rather than over a network.

## Likely interviewer questions

1. **Is this exactly-once?** No. It is at-least-once processing with deduplication: conditional claim, per-channel attempt records, provider idempotency key, API idempotency key, deterministic job id. The small window described in section 1 is why in-app items are deduped by the client.
2. **What happens if a worker dies mid-send?** BullMQ redelivers after the lock expires (`maxStalledCount` 3, `src/worker-runtime.ts:15`); the claim accepts `sending`; sent channels are skipped. `tests/chaos.integration.test.ts` kills a real worker process with 20 in flight and checks every notification delivered once; it passed 20 of 20 runs, and `tests/chaos-variants.integration.test.ts` adds 100 and 500 in flight, one of two workers killed, all workers killed and Redis restarts (9 variants, 3 runs each, all passed). With production lock timings recovery took about 61 seconds. See `docs/evidence/chaos/ANALYSIS.md` for what is and is not proven.
3. **What if Redis loses everything?** Postgres still has every row. The sweeper re-enqueues stuck rows. Live WebSocket pushes in that window are lost but the inbox replays from Postgres.
4. **How do retries work?** 5 attempts, exponential backoff starting at 1 s with 0.5 jitter (`src/queue.ts:7-9`). A permanent error (bad address, missing template) skips retries and goes straight to `failed`. `failed` is the dead-letter set; `POST /v1/notifications/:id/replay` moves it back to `queued`. Tests use a shortened backoff, so the real timing values are configuration, not something the tests clock.
5. **How is multi-tenancy enforced?** The tenant comes from the hashed API key, never the body; every query includes `tenant_id`. `tests/tenant-isolation.integration.test.ts` checks that one tenant cannot read, list, replay, erase, mark read, see the stats or dead letters of another's data, send to another's user or revoke another's keys, and that the same `Idempotency-Key` in two tenants stays separate. Removing the tenant filter from one route makes that test fail. The WebSocket stream's isolation is not covered by those tests.
6. **Why a queue at all, and why Postgres as truth?** Sends must not block the request or depend on a provider being up; the DB row is what makes retries, audit, dashboards and recovery possible.
7. **How would it scale?** Add API instances (Redis pub/sub fans out, rate limit is shared) and workers (concurrency 10 each). Bottlenecks I would watch: Postgres write rate, the single Redis, and the sweeper's 100-row batches. The numbers I have are laptop benchmarks only.
8. **What are the benchmark limits?** One laptop, Postgres on the same machine, mock email channel (no network), three runs per row (single runs for the ceiling search), k6 competing for the same CPU. The API accepted 18,000 a minute but the worker delivered about 11,000 a minute, and the 24 ms p95 I first measured did not reproduce (46 to 81 ms). They show the internal pipeline's capacity, not real-provider throughput.
9. **What is not implemented or tested?** The Resend adapter is tested against a mocked `fetch` (its request shape and error classification), but I have not sent real email through it in evidence I can show; Postgres outages and WebSocket delivery are not part of the chaos tests; no auth beyond API keys; no per-channel provider failover; no multi-region.
10. **Did you write this yourself?** The project was built with an AI coding assistant (Claude Code) and committed under my name. I directed the design (phases, guarantees, trade-offs) and I can walk through every mechanism above and the decision records in `docs/DECISIONS.md`. Give a straight answer about what you decided versus what was generated, and be ready to modify the code live.
11. **Tell me about a bug you found and fixed.** Use section 7: rehearsing the demo on the real stack, a 500 that was really a 415, a handler that only knew one 4xx status, tests first, and fixing the category instead of the single case.
