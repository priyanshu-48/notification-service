# Chaos test: what was run and what it proves

## Result
`npx vitest run tests/chaos.integration.test.ts` was run **20 times in a row** on commit `8bc647f` (code under test is identical to `2198e13`; only tests and docs differ), 2026-10-08. Environment: `docs/evidence/ENVIRONMENT.md`.

| | |
|---|---|
| Runs | 20 |
| Passed | **20** (exit 0 each; `Tests 1 passed (1)`) |
| Failed | 0 |
| Wall time per run | 8 to 10 s (`baseline-20x/status.txt`) |
| Raw output | `baseline-20x/run1.log` ... `run20.log`, `status.txt` |

20 of 20 is a pass rate on this one machine and one scenario. It does not prove the failure can never happen; it says it did not happen in 20 attempts.

## What each run does (`tests/chaos.integration.test.ts`)
1. Starts real PostgreSQL 17 and Redis 7 containers (Testcontainers), runs the migrations.
2. Inserts 20 notifications (`total = 20`) and enqueues them.
3. Starts worker A as a **separate OS process**. Its fake provider records the send first (`calls.txt`, and `sink.txt` if the idempotency key is new) and only then sleeps 1.5 s before returning (`tests/chaos-worker.ts`).
4. Waits until at least 3 sends have been recorded, then `SIGKILL`s worker A (no cleanup, no graceful shutdown). So the kill lands in the dangerous window by construction: the provider has accepted the message but our `sent` attempt row has not been written.
5. Asserts the crash really left work half-done (rows stuck in `sending`, greater than 0).
6. Starts worker B, waits up to 60 s for all 20 to reach `delivered`.

## What the assertions prove
- All 20 notifications reach `delivered` after the crash (none lost).
- The provider's receipt sink has **20 distinct entries and exactly 20 lines** (the fake provider keeps one entry per idempotency key, so this shows the key was identical on the retry after the crash; it is the provider-side dedupe the real Resend `Idempotency-Key` is meant to give).
- More provider calls were attempted than 20 (`calls.txt` longer than 20), so the crashed sends really were retried and the dedupe did the work, not luck.
- Every notification has exactly **one `sent` delivery attempt** row.

## What is NOT proven
- Only 20 notifications and one kill moment. Larger batches and other kill points are untested here (see variants below).
- Only worker A is killed; worker B is healthy. A simultaneous kill of all workers, or killing B too, is untested.
- Redis and Postgres stay up. Neither a Redis restart nor a Postgres outage is part of this test.
- The provider is a local fake that honours the idempotency key as the test defines it: it only adds a key to the sink once, so a duplicate send shows up as extra `calls.txt` lines, and a changed key would show up as extra sink lines. What the test shows is that the key stays the same per notification across the crash and retry. Real Resend dedupe behaviour is not exercised; the key is sent, but Resend's handling is the provider's guarantee, not ours.
- The in-app channel is not part of this test (it relies on client-side dedupe by id).
- Everything runs on one laptop under Docker Desktop; no network failures.

## Honest wording for the resume
"A chaos test that SIGKILLs a real worker process mid-send with 20 notifications in flight; all 20 were delivered, each with one stable idempotency key and exactly one recorded successful attempt, repeated 20 times with 20 of 20 passing."
Do not write "zero duplicates in production" or "exactly-once".

---

# Variants (added 2026-10-08, `tests/chaos-variants.integration.test.ts`)

Same end-state assertions as the original (all delivered, one provider receipt each, exactly one `sent` attempt each); only the injected failure and the scale change. Each variant has its own fresh Postgres and Redis containers. The chaos worker (`tests/chaos-worker.ts`) gained optional env switches; its defaults are unchanged, and the original test still passes (4 s).

## Result: 9 variants x 3 full runs = 27 of 27 passed
Raw logs: `variants/final-run1.log` to `final-run3.log`, `variants/final-status.txt`.

| Variant | What is injected | Result |
|---|---|---|
| 100 in flight | worker A SIGKILLed after 3 sends, fresh worker finishes | pass 3/3 |
| 500 in flight | same, 500 notifications | pass 3/3 |
| killed after the first send | kill at the earliest observable moment | pass 3/3 |
| killed after 10 sends | a second wave of sends already in flight | pass 3/3 |
| two workers, one killed | A and B run together, A killed, B alone finishes | pass 3/3 |
| all workers killed | A and B killed together, then a new worker starts | pass 3/3 |
| production timings | as the original but with BullMQ's default 30 s lock and stall check, concurrency 10, sweeper 30 s / 60 s | pass 3/3; **recovery took 61 s after the kill, in each of the 3 runs** |
| Redis graceful restart | Redis restarted mid-run with data saved to disk; no worker killed | pass 3/3 |
| Redis restart that loses all data | Redis restarted with persistence off, so the whole queue is gone; the sweeper (shortened: every 2 s, rows idle 5 s) rebuilds it from Postgres | pass 3/3 |

## Important caveats (read before quoting any of this)
1. **The original test uses shortened timings.** Its worker sets a 2 s lock and a 1 s stall check, and has no sweeper, so its crash recovery takes seconds. Shipped defaults are BullMQ's 30 s / 30 s. The "production timings" variant uses the shipped values: recovery took **61 s**, so real crash recovery is about a minute, not a few seconds. Quote the 61 s figure for "time to recover", not the 9 s test duration.
2. **A first attempt at the Redis restart variant FAILED, and that was informative.** I restarted Redis with Testcontainers' default `restart()`, which kills it immediately with nothing saved to disk, and ran workers with no sweeper. After 180 s, 85 of 100 notifications were still `queued` in Postgres while the Redis queue was empty (`variants/run1-first-attempt.log`; the reproduction printed `notifications by status: queued 85, delivered 15; queue: all zero`). Conclusion: if Redis loses its queue, **the sweeper is what recovers the work**; without it, work stays `queued` forever. The shipped worker always runs the sweeper (`src/worker-runtime.ts:20-22`), and the "loses all its data" variant shows it recovering everything. I then made the "graceful" variant genuinely graceful (`restart({ timeout: 10_000 })`). This is a test-design correction, not an application change, and I am reporting it rather than hiding it.
3. The Redis-data-loss variant uses a shortened sweeper (2 s / 5 s). With production values (30 s / 60 s) recovery would take about 1.5 minutes or more. That value was not measured.
4. Redis restarts do not require a retried send, so the "more provider calls than notifications" check is only asserted for the worker-kill variants.
5. Postgres is never interrupted in any variant. In-app (WebSocket) delivery is not part of these tests. The provider is still the local fake. Still one laptop.

## Resume wording that these results support
"Verified crash recovery with a chaos suite that SIGKILLs real worker processes mid-send (20 to 500 notifications in flight, single worker, one of two workers, all workers) and restarts Redis (including total queue loss), all with zero lost notifications and exactly one recorded delivery each; with production lock timings, recovery took about 1 minute."

## Running the variants
`npx vitest run tests/chaos-variants.integration.test.ts` runs 8 variants (about 1.5 minutes). The production-timing variant (about 65 s) is opt-in: `CHAOS_SLOW=1 npx vitest run tests/chaos-variants.integration.test.ts` (PowerShell: `$env:CHAOS_SLOW="1"` first). Its 3 passing runs above were done with it enabled.
