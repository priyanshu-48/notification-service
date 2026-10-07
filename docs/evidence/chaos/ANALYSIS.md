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
