# Resume evidence

Every figure here was produced by a command in this repository; the raw output is under `docs/evidence/` and `loadtest/RESULTS.md`. Machine and tool versions: `docs/evidence/ENVIRONMENT.md`. Branch `evidence/resume-metrics`; final verification on commit `5aedc2d` (dated 2026-10-08). Figures marked **branch only** exist only on this branch until it is merged to `main`, so merge it before quoting them.

## 1. Claim table

| Claim | Verified value | Command | Commit | Date | Raw output | Caveats |
|---|---|---|---|---|---|---|
| Test count | **117 tests in 19 files; 116 run by default, 1 opt-in** (production-timing chaos). On `main`: 86 tests in 16 files, 3 clean-checkout runs all 86/86 | `npx vitest run` / `npm run test:coverage`; clean checkout via git worktree + `npm ci`, run 3 times | main numbers: `2198e13`; branch numbers: `5aedc2d` | 2026-10-07/08 | `docs/evidence/tests/summary.txt`, `run1-3.json`, `final-run.log` | No flaky test in 3 runs. 117 is **branch only**. |
| Real infrastructure in tests | **10 of 19 test files start a real PostgreSQL container; 6 of those also start real Redis** (Testcontainers). On `main`: 8 of 16 and 5 | `grep -l 'PostgreSqlContainer(' tests/*.test.ts`; same for `GenericContainer('redis` | `5aedc2d` | 2026-10-08 | `docs/evidence/tests/container-usage.txt` (main numbers; the branch numbers are the command output above) | The earlier claim "6 also Redis" was wrong; it was 5 on `main`. |
| Line coverage | **81.99%** (419/511); statements 80.94%, branches 78.24%, functions 77.92%. On `main` 79.84% (408/511) | `npm run test:coverage` (v8, `src/**` only) | `5aedc2d` (main: `2198e13`) | 2026-10-08 | `docs/evidence/tests/final-run.log`, `coverage-before-after.txt`, `coverage/coverage-summary.json` | 82% is **branch only**. Still 0%: `server.ts`, `worker.ts`, `worker-runtime.ts`, `db/client.ts`, `db/migrate.ts`, `scripts/provision-tenant.ts` (entry points). Resend adapter now 100% via mocked `fetch`, not a real provider. |
| API surface | **22 documented operations on 17 paths**, 29 schemas | `grep -c operationId docs/openapi.yaml`; route table vs spec by `tests/openapi.test.ts` | `2198e13` | 2026-10-07 | `docs/evidence/api/openapi-count.txt` | The 22 **include** the WebSocket `GET /stream`, `/health`, `/ready`, `/metrics`; 18 are `/v1/*`. `GET /` and `GET /demo` are excluded on purpose. |
| Spec cannot drift | An undocumented route, a removed spec path, and a spec route with no handler each make `tests/openapi.test.ts` fail; reverting passes 9/9 | see file | `8b265c5` | 2026-10-07 | `docs/evidence/api/drift-demo.txt` | |
| Crash safety | Chaos test (SIGKILL of a real worker process, 20 in flight): **20 of 20 runs passed**; all 20 delivered each time, one `sent` attempt each, stable idempotency key | `npx vitest run tests/chaos.integration.test.ts` x20 | `8bc647f` | 2026-10-08 | `docs/evidence/chaos/baseline-20x/` | Original test uses shortened lock/stall timings and a local fake provider. `docs/evidence/chaos/ANALYSIS.md` lists what is **not** proven. |
| Chaos variants | **9 variants x 3 runs = 27/27 passed**: 100 and 500 in flight, kill after 1 and after 10 sends, one of two workers killed, all workers killed, production lock timings, Redis graceful restart, Redis restart losing all queue data (sweeper rebuilds). No lost, no duplicated | `npx vitest run tests/chaos-variants.integration.test.ts` (opt-in variant: `CHAOS_SLOW=1`) | `5ecce7a` | 2026-10-08 | `docs/evidence/chaos/variants/final-run1-3.log` | **branch only**. With **production timings recovery took 61 s** (3 of 3 runs). Redis-loss variant uses a shortened sweeper. A first attempt failed because my test killed Redis with no sweeper running, which showed the sweeper is what recovers the queue (`run1-first-attempt.log`). Postgres outages not tested. |
| Retries | 5 attempts, exponential backoff 1 s base with 50% jitter; permanent errors skip retries; dead-letter and replay | `tests/phase4.integration.test.ts:107-149`, `tests/resend-email-channel.test.ts` ("retry configuration") | `8bc647f` | 2026-10-08 | test files | Integration tests use a shortened backoff, so the real timing is configuration pinned by a test, not a measured delay. |
| Multi-tenancy | Tenant B cannot read, list, replay, erase, mark-read, or see stats and dead letters of tenant A, send to A's user, or revoke A's keys; same Idempotency-Key in two tenants stays separate; a revoked key returns 401 | `npx vitest run tests/tenant-isolation.integration.test.ts` | `8bc647f` | 2026-10-08 | `docs/evidence/tests/coverage-before-after.txt` (mutation check) | **branch only**. Removing the tenant filter on `GET /v1/notifications/:id` made the test fail, then reverted. WebSocket stream isolation is not covered by these tests. |
| Load: API acceptance | Uncapped, 3 runs each: 100/s accepts 6,001, **300/s (18,000/min) accepts 18,001 (18,000-18,001)**; every accepted notification delivered (Postgres count), 0 failed | `RAW_OUT=... loadtest/run-local.sh <rate> 60s` | image from `5ecce7a` (src same as `2198e13`) | 2026-10-07/08 | `docs/evidence/loadtest/raw/`, `summary.md`, `loadtest/RESULTS.md` | Mock email, Postgres on same laptop, k6 on same machine. |
| Load: latency | p95 at 300/s: **46-81 ms** across 6 runs (45.6-55.3 ms with CPU sampler, 67.5-81.3 ms without). 100/s: 18-22 ms. 200/s: 30-72 ms | same | same | same | same + `raw-no-sampler/` | **The earlier "24 ms" was not reproduced** and should not be used. |
| Load: delivery throughput | Worker finishes about **10,500-11,500 notifications/min** (175-190/s, each to two channels); above ~200/s a backlog builds (30-48 s drain at 300/s) | same, rates 300-800/s | same | same | `loadtest/RESULTS.md` | Ceiling steps (400-800/s) are single runs. API acceptance plateaus near 32,000/min; first dropped requests at 400/s. |
| Free-tier-sized container | 0.1 CPU/512 MB: saturated throughput **~943/min with embedded Redis (918-951), ~1,010/min with separate Redis (967-1,017)**. Embedded cost **~7%** (about 2-10%) | same with `0.1 512m`, `EMBEDDED_REDIS=1` | same | same | same | Replaces README's "15 to 25%" and the earlier 14% estimate. It is an emulation, not a measurement of Render. |
| CI | Latest `main` run green: https://github.com/priyanshu-48/notification-service/actions/runs/37651947230 | `gh run list --branch main` | `2198e13` | 2026-10-07 | `docs/evidence/ci/ci-status.txt` | CI has 8 steps (checkout, setup-node, install, lint, build, dashboard build, test, SDK build). No coverage step yet. The branch is not pushed, so CI has not run on it. |
| Stack | See section 3 | | | | | |

Not done / not measurable here: real Resend email delivery, live Render instance load, any user or traffic counts, GitHub stars.

## 2. Recommended resume wording

Quote only what is on `main` once the branch is merged (or quote the `main` numbers in brackets until then).

**Bullet 1: system and API**
> Built a multi-tenant notification service (TypeScript, Fastify, PostgreSQL, Redis, BullMQ) with 22 documented API operations including a WebSocket stream, delivering email and real-time in-app notifications through a job queue, with a React operator dashboard and a typed SDK.

("22 documented operations" includes the stream and ops endpoints, so the wording says so. Do not say "22 REST endpoints".)

**Bullet 2: reliability** (if you keep the earlier phrase, it is true but weaker than what is now proven)
> Designed at-least-once delivery with deduplication (idempotency keys, conditional state transitions, per-channel attempt tracking, exponential-backoff retries, dead-letter replay); verified with chaos tests that SIGKILL real worker processes mid-send (20 to 500 notifications in flight, single and multiple workers, Redis restarts) with no notification lost and exactly one recorded delivery each, recovering in about a minute under production lock timings.

Do not write "exactly-once" or "zero duplicates". The honest wording is "no duplicate recorded delivery" and "idempotent".

**Bullet 3: testing and load**
> Load-tested with k6: the API accepted 18,000 notifications/min (300/s) with 0 lost and p95 under 100 ms on a laptop (mock email), with worker throughput of about 11,000/min and a documented capacity of about 940/min on a 0.1-CPU container. Wrote 117 tests (82% line coverage; 10 test files run against real PostgreSQL/Redis via Testcontainers) in a GitHub Actions CI pipeline.

If you cannot use branch-only numbers yet, write "86 tests (79.8% line coverage; 8 suites on real PostgreSQL, 5 also on Redis)". Do **not** write "18,000/min delivered".

**Stack line** (all verified in the repo): TypeScript, Node.js, Fastify, PostgreSQL, Redis, BullMQ, WebSockets, React, Docker, Render, Vitest, k6. Safe additions: Testcontainers, GitHub Actions, Drizzle ORM, Zod, OpenAPI. Caveat: Render is a free-tier deployment whose database expires in early November unless migrated (`docs/NEON_MIGRATION.md`).

## 3. Claims that could not be backed, with weaker true wording

| Original | Problem | Use instead |
|---|---|---|
| "24 ms p95" | Not reproducible; 46-81 ms measured at 300/s | "p95 under 100 ms" |
| "18,000 notifications/min ... 0 loss" | Accepted rate, not delivered rate | "accepted 18,000/min; delivered about 11,000/min sustained" |
| "8 suites on real PostgreSQL/Redis" | 8 Postgres, 5 with Redis on `main` | "8 of 16 test files on real PostgreSQL, 5 also on Redis" |
| "delivering email" | Only the mock was used for end-to-end runs; Resend adapter tested with a mocked `fetch` | "email via a provider adapter (Resend)" and see section 5 |
| "multi-tenant" | Isolation tests were partial on `main` | Fine on this branch; add "with cross-tenant isolation tests" |
| "backoff with jitter" | Config is pinned, timing not measured | Fine as "exponential-backoff retries" |
| 15-25% embedded Redis cost (README) | Not supported | ~7% (README corrected) |

## 4. Other tests that could produce stronger, true metrics (not done)
1. Soak test: 30-60 min at a moderate rate; memory growth, queue drain, zero loss.
2. WebSocket fan-out: N concurrent sockets and send-to-receive latency distribution (an actual real-time latency number, which the project does not have yet).
3. Postgres restart during load; Redis flush then measured sweeper recovery time at production sweeper settings (30 s / 60 s).
4. 100 parallel identical idempotency-key requests produce exactly 1 notification.
5. Mutation testing (Stryker) on `state-machine.ts` and `rate-limit.ts` for a test-quality score.
6. `npm audit` and a container image scan for a security line.
7. Real Resend run (`scripts/evidence/send-real-emails.mjs`) and a low-rate k6 run against the live Render service (steps in `docs/evidence/PROPOSALS.md`).

## 5. Questions only you can answer
1. Did you send real email through Resend? How many, and did they arrive? (The script and steps are ready; I have not run them because they need your keys.)
2. Do you want me to merge the branch (PR) so the 117 tests, 82% coverage and the corrected README are on `main` before you quote them?
3. How many real tenants or users use this (the tracker?) and how many notifications has the live service delivered?
4. What are the real numbers on the live Render instance (low-rate k6 command in `PROPOSALS.md`)?
5. Hours spent and what you directed versus what the AI assistant generated. Be ready for this in interviews; `docs/INTERVIEW_NOTES.md` covers the mechanisms.
6. Do you want a public demo (needs key scopes and per-tenant limits, a code change) or a recording in the README?
7. Do you want the coverage step added to CI (`PROPOSALS.md` E.2) and a Neon migration done before November?
8. Is the untracked `RESUME_EXPORT_notification_service.md` yours? I left it alone. It is not part of this branch.
