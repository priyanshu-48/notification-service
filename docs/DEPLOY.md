# Deploying to Render

`render.yaml` is a Blueprint for one **free** web service and a free Postgres database. The service runs the API, dashboard, WebSocket gateway, the worker **and a small embedded Redis** in one container.

**Why Redis is embedded:** Render allows only **one free Key Value instance per workspace**. The first deploy of this Blueprint failed with `cannot have more than 1 free tier Key Value instance` because the workspace already used its one for another project. Running Redis inside the container (`START_EMBEDDED_REDIS=true`, see `docker-entrypoint.sh`) needs no extra instance. Redis keeps nothing on disk, is capped at 64 MB, and never evicts keys.

> The Docker image, including embedded Redis, was tested locally against a fresh database. The Blueprint itself has **not** yet been deployed successfully to a Render account. If Render rejects a field, its error names it; the fix is usually a one-line edit to `render.yaml`.

## Steps

1. Push this repo to GitHub (done) and sign in to Render.
2. **New > Blueprint**, pick the repo. Render reads `render.yaml`, shows the two resources, and asks for `RESEND_API_KEY` and `EMAIL_FROM`. Leave both blank to keep the safe mock email channel.
3. Wait for the first deploy. The container runs the database migrations, then starts the server. `/ready` must return 200 for Render to route traffic.
4. Create your first tenant. Free web services have no shell, so run the provisioning script from your machine against the database. In the Render dashboard open the database and copy its **External Database URL**, then:

   ```bash
   DATABASE_URL="<external url>?sslmode=require" npm run provision:tenant -- "My first app"
   ```

   It prints a one-time `ntf_live_...` key. Use it to sign in at `https://<your-service>.onrender.com/dashboard/`.
5. Smoke test: `curl https://<your-service>.onrender.com/ready`, then send a notification with the SDK or `curl` (see the README).

`/metrics` requires `Authorization: Bearer <METRICS_TOKEN>`; Render generated the token, find it under the service's Environment tab.

## What the free tier does to this service

These are Render's documented free-tier limits and how they interact with the design. They are fine for a portfolio demo and not for production.

| Limit | Effect | Why it is acceptable here |
|---|---|---|
| Web service sleeps after 15 minutes without inbound traffic | The worker sleeps with it, so delayed jobs (quiet hours, digest windows) and retries wait until the next request wakes the service. Open WebSockets drop; the SDK reconnects. The first request after idle is slow (cold start). | The sweeper and BullMQ pick everything back up on wake. Do not quote latency from a cold request. |
| Embedded Redis lives and dies with the container | **Every sleep and restart empties the queue, the in-flight jobs, the delayed jobs and the rate-limit buckets.** A separate Key Value instance would survive web-service sleeps; this does not. | Every notification is already in Postgres. On wake the sweeper (runs every 30 s) re-enqueues anything still `queued` or `sending`, and delayed notifications keep their remaining delay because `deliverAfter` is stored in Postgres. Rate-limit buckets simply refill. |
| If the embedded Redis process crashes, nothing restarts it | `/ready` returns 503 within 2 s and names `redis`, and Render replaces the unhealthy instance. | Acceptable for a demo; a supervised or managed Redis is the fix for real use. |
| Free Postgres expires 30 days after creation (14-day grace) | **The deployment and its data are deleted.** | Upgrade the database, or point `DATABASE_URL` at another Postgres, before day 30 if the live link matters. |
| One free web service, 750 instance hours a month | Fine for one service. | The single-process mode (`RUN_WORKER=true`) is what makes the whole system fit in one free service; a separate worker would need a paid plan. |

For anything real, use paid plans, a managed Redis (set `REDIS_URL`, leave `START_EMBEDDED_REDIS` unset), and run the worker as its own process (`npm run worker`, or the same image with a different start command) so API traffic and delivery scale and fail independently. **Never run embedded Redis with more than one app instance:** each instance would get its own separate Redis, and queues, pub/sub and rate limits would split.

## Configuration

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Provided by the Blueprint. |
| `REDIS_URL` | `redis://127.0.0.1:6379` with the embedded Redis; set it to a managed Redis instead for real deployments. |
| `START_EMBEDDED_REDIS` | `true` starts a local Redis in the container before the app. Unset everywhere else. |
| `STREAM_TOKEN_SECRET` | HMAC secret for end-user WebSocket tokens (generated). Changing it invalidates outstanding tokens. |
| `METRICS_TOKEN` | Bearer token for `/metrics` (generated). Unset means `/metrics` is open. |
| `RUN_WORKER` | `true` runs the worker inside the API process. |
| `WORKER_CONCURRENCY` | Jobs processed in parallel per worker (default 10). |
| `DB_POOL_MAX` | Postgres connections per process (default 10). Keep `WORKER_CONCURRENCY` at or below it. |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST` | Per-tenant token bucket. |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM` | `mock` (default) or `resend`. |

## Operations

- `GET /health`: the process is up. `GET /ready`: Postgres and Redis both answer (503 and the failing dependency otherwise).
- `GET /metrics`: Prometheus format. `notifications{status}` (from Postgres, all tenants), `notification_queue_jobs{state}` (from Redis), `http_request_duration_seconds{method,route,status}` and the default Node process metrics. Delivery outcomes are read from the database rather than counted in the worker, so one scrape of the API is accurate even when the worker is a separate process.
- Logs are structured JSON (pino), one line per request with a request id. The stream token is redacted from request URLs.
