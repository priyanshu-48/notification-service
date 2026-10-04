#!/bin/sh
set -e

# Optional single-container mode (e.g. Render's free tier, which allows only one free Key Value instance per workspace):
# run a small Redis next to the app. It keeps nothing on disk, so a restart or sleep empties the queue; the sweeper then
# rebuilds it from Postgres. Use a real Redis for anything beyond a demo, and never with more than one app instance.
if [ "$START_EMBEDDED_REDIS" = "true" ]; then
  redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no --dir /tmp \
    --maxmemory 64mb --maxmemory-policy noeviction > /tmp/redis.log 2>&1 &
  i=0
  until redis-cli -h 127.0.0.1 ping > /dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 50 ]; then echo "Embedded Redis did not start:" >&2; cat /tmp/redis.log >&2; exit 1; fi
    sleep 0.2
  done
  echo "Embedded Redis ready"
fi

# Migrations are idempotent, so running them on every start is safe and keeps deploys one step.
node dist/db/migrate.js
exec node dist/server.js
