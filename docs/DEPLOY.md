# Deploying to Render

`render.yaml` is a Blueprint for one **free** web service. The service runs the API, dashboard, WebSocket gateway, the worker **and a small embedded Redis** in one container. Postgres is **not** created by the Blueprint: you bring a free external Postgres that does not expire (see below).

**Why Redis is embedded:** Render allows only **one free Key Value instance per workspace**. The first deploy of this Blueprint failed with `cannot have more than 1 free tier Key Value instance` because the workspace already used its one for another project. Running Redis inside the container (`START_EMBEDDED_REDIS=true`, see `docker-entrypoint.sh`) needs no extra instance. Redis keeps nothing on disk, is capped at 64 MB, and never evicts keys.

**Why Postgres is external:** Render's free Postgres **expires 30 days after creation** (then a 14-day grace period before deletion). A portfolio link that dies after a month is not useful, so use a free Postgres host with no expiry. Neon is a common choice; Supabase and Aiven also have free tiers with different limits. Free-tier terms change, so check the current limits and pick the one that fits.

> Verified: the external-Postgres variant of this Blueprint is deployed on Render against a free Neon database, and delivered a test notification end to end (2026-10-09). The earlier version with Render's own Postgres also worked.

## Steps

1. **Create a free Postgres** at your chosen host and copy its connection string. It must require SSL (`sslmode=require`). Use the **direct** connection, not a pooled one.
2. Push this repo to GitHub and sign in to Render.
3. **New > Blueprint**, pick the repo. Render shows one resource and asks for `DATABASE_URL` (paste the string from step 1), and for `RESEND_API_KEY` and `EMAIL_FROM` (leave both blank to keep the safe mock email channel).
4. Wait for the first deploy. The container runs the database migrations, then starts the server. `/ready` must return 200 for Render to route traffic. Opening the bare URL redirects to the dashboard.
5. Create your first tenant. Free web services have no shell, so run the provisioning script from your machine against the same database:

   ```powershell
   $env:DATABASE_URL = "<the connection string from step 1>"
   npm run provision:tenant -- "My first app"
   Remove-Item Env:DATABASE_URL
   ```

   It prints a one-time `ntf_live_...` key. Keep it private. Use it to sign in at `https://<your-service>.onrender.com/dashboard/`. If you see an SSL error, also set `$env:PGSSLMODE = "require"`.
6. Smoke test: open `/ready`, then send a notification with the SDK or `Invoke-RestMethod` (see the README) and check that it shows as `delivered` in the dashboard.

`/metrics` requires `Authorization: Bearer <METRICS_TOKEN>`; Render generated the token, find it under the service's Environment tab.

## Moving an existing deployment off Render's free Postgres

If the service already runs against a Render-created database:

1. Create the external Postgres (step 1 above).
2. Merge this Blueprint change, then in the Render dashboard open the service's **Environment** tab and set `DATABASE_URL` to the new connection string. Check that `READY_TIMEOUT_MS` is `4000`.
3. Trigger a manual deploy. The migrations create the schema in the new database.
4. Run the tenant provisioning command (step 5) against the new database. **Your old tenant, API keys and notifications do not move**, so you get a new key.
5. Check `/ready` and send a test notification.
6. Delete the old Render database, so it can't expire on you or hold stale data.

## What the free tier does to this service

These are the documented free-tier limits and how they interact with the design. They are fine for a portfolio demo and not for production.

| Limit | Effect | Why it is acceptable here |
|---|---|---|
| Render web service sleeps after 15 minutes without inbound traffic | The worker sleeps with it, so delayed jobs (quiet hours, digest windows) and retries wait until the next request wakes the service. Open WebSockets drop; the SDK reconnects. The first request after idle is slow (cold start). | The sweeper and BullMQ pick everything back up on wake. Do not quote latency from a cold request. |
| Embedded Redis lives and dies with the container | **Every sleep and restart empties the queue, the in-flight jobs, the delayed jobs and the rate-limit buckets.** A separate Key Value instance would survive web-service sleeps; this does not. | Every notification is already in Postgres. On wake the sweeper (runs every 30 s) re-enqueues anything still `queued` or `sending`, and delayed notifications keep their remaining delay because `deliverAfter` is stored in Postgres. Rate-limit buckets simply refill. |
| If the embedded Redis process crashes, nothing restarts it | `/ready` returns 503 within the check timeout and names `redis`, and Render replaces the unhealthy instance. | Acceptable for a demo; a supervised or managed Redis is the fix for real use. |
| Free external Postgres hosts may suspend an idle database | The first query after a pause can take a few seconds, so `/ready` could report 503 if its check gives up first. | `READY_TIMEOUT_MS=4000` in the Blueprint gives the database time to wake. Raise it if you still see 503 right after idle. Whether a given host suspends, and for how long, depends on the host: check its current terms. |
| One free Render web service, 750 instance hours a month | Fine for one service. | The single-process mode (`RUN_WORKER=true`) is what makes the whole system fit in one free service; a separate worker would need a paid plan. |

For anything real, use paid plans, a managed Redis (set `REDIS_URL`, leave `START_EMBEDDED_REDIS` unset), and run the worker as its own process (`npm run worker`, or the same image with a different start command) so API traffic and delivery scale and fail independently. **Never run embedded Redis with more than one app instance:** each instance would get its own separate Redis, and queues, pub/sub and rate limits would split.

## Configuration

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string. You provide it (the Blueprint does not create a database). Must require SSL on hosted databases. |
| `REDIS_URL` | `redis://127.0.0.1:6379` with the embedded Redis; set it to a managed Redis instead for real deployments. |
| `START_EMBEDDED_REDIS` | `true` starts a local Redis in the container before the app. Unset everywhere else. |
| `READY_TIMEOUT_MS` | How long `/ready` waits for Postgres and Redis before reporting them down (default 2000; the Blueprint uses 4000). |
| `STREAM_TOKEN_SECRET` | HMAC secret for end-user WebSocket tokens (generated). Changing it invalidates outstanding tokens. |
| `METRICS_TOKEN` | Bearer token for `/metrics` (generated). Unset means `/metrics` is open. |
| `RUN_WORKER` | `true` runs the worker inside the API process. |
| `WORKER_CONCURRENCY` | Jobs processed in parallel per worker (default 10). |
| `DB_POOL_MAX` | Postgres connections per process (default 10). Keep `WORKER_CONCURRENCY` at or below it. Free hosted databases often allow few connections, so lower this if you see connection errors. |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST` | Per-tenant token bucket (defaults 600 and 100). |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM` | `mock` (default) or `resend`. |

## Operations

- `GET /health`: the process is up. `GET /ready`: Postgres and Redis both answer (503 and the failing dependency otherwise). `GET /`: redirects to the dashboard.
- `GET /metrics`: Prometheus format. `notifications{status}` (from Postgres, all tenants), `notification_queue_jobs{state}` (from Redis), `http_request_duration_seconds{method,route,status}` and the default Node process metrics. Delivery outcomes are read from the database rather than counted in the worker, so one scrape of the API is accurate even when the worker is a separate process.
- Logs are structured JSON (pino), one line per request with a request id. The stream token is redacted from request URLs.
