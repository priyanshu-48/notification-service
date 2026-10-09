# Moving the database from Render's free Postgres to Neon (runbook)

> **Done on 2026-10-09.** The service was recreated from the Blueprint with a Neon `DATABASE_URL`; its new address is https://notification-service-2xde.onrender.com (the old `-4pp9` address is gone). `/ready` was healthy and a test notification was delivered. Kept for reference and for repeating the move to another host.

Why: Render's free Postgres is deleted about 30 days after creation. Neon's free tier does not expire.
Everything here is done by you in your own accounts. No connection strings go in chat or in git.

## Before you start
- Decide whether you need the old data. It is a demo database. The simplest path is to **start fresh** (steps 1 to 6). To keep data, see the optional section at the end.
- Neon connection strings must use SSL (`?sslmode=require`).

## Steps
1. In Neon, create a project and a database, and copy the connection string. The direct one is simpler for migrations.
2. In Render, the Blueprint made `DATABASE_URL` a `sync: false` input, which the GUI does not let you edit after the first deploy. Recreate the service from the Blueprint (delete the web service and apply the Blueprint again), entering the Neon string when prompted. The service URL may change; if it does, update any client and docs that mention it.
3. Wait for the deploy. The container runs the migrations on start, creating the schema in Neon. `GET /ready` must return 200 with postgres and redis true.
4. Create a tenant and key against Neon from your machine. In PowerShell, type the string yourself:
   - `$env:DATABASE_URL = Read-Host "Neon connection string"`
   - `$env:PGSSLMODE = "require"`
   - `npm run provision:tenant -- demo`
   - `Remove-Item Env:DATABASE_URL`

   Save the printed key in your password manager only.
5. Verify: `/ready` is 200; sign in to the dashboard with the new key; send one test notification and see it `delivered`; run the live k6 command from `docs/evidence/PROPOSALS.md` (F.2) at a low rate.
6. Only after step 5 passes: delete the old Render Postgres (`notification-db`). Update `docs/DEPLOY.md` and the README note about the 30-day expiry.

## If you want to keep the old data (optional)
`pg_dump` the old database with its external connection string, then restore into Neon. Do it on a throwaway Neon branch first. Data-only restore after the migrations have created the schema is the safer order.

## Things to check afterwards
- Neon scales to zero when idle, so the first query after a pause is slow. `READY_TIMEOUT_MS` (default 2000) can mark the service not ready on a cold database. Set it to 4000 as `docs/DEPLOY.md` suggests.
- The distraction tracker needs the new tenant's key and, if the URL changed, the new base URL.
- Old API keys stop working (new database). Rotate anywhere they were stored.
- Rollback: the old Render database exists until step 6, so point `DATABASE_URL` back if something is wrong.
