#!/usr/bin/env bash
# Reproducible local load test: throwaway Postgres database and Redis, the production Docker image (API + worker in one
# process, like the Render deployment) and the k6 script, optionally CPU/memory capped to approximate a small instance.
#
#   loadtest/run-local.sh [RATE per second] [DURATION] [CPUS] [MEMORY]
#   loadtest/run-local.sh 100 60s            # uncapped
#   loadtest/run-local.sh 20 60s 0.1 512m    # roughly Render's free instance (0.1 CPU, 512 MB)
#   EMBEDDED_REDIS=1 loadtest/run-local.sh 20 60s 0.1 512m   # Redis inside the app container too, as deployed on Render
#   RAW_OUT=file loadtest/run-local.sh ...   # also save the full k6 output, a Postgres count of the results, and CPU samples (file.stats)
#
# Needs: docker, the compose Postgres from `docker compose up -d postgres` (port 5433), and `docker build -t notification-service:local .`
set -euo pipefail
export MSYS_NO_PATHCONV=1
RATE=${1:-100}; DURATION=${2:-60s}; CPUS=${3:-}; MEM=${4:-}
PG=postgres://notifications:notifications@localhost:5433
DB=loadtest_$$
APP=ns-load-app; REDIS=ns-load-redis; K6=ns-load-k6

cleanup() {
  [ -n "${SAMPLER:-}" ] && kill "$SAMPLER" 2>/dev/null || true
  docker container rm -f "$APP" "$REDIS" "$K6" >/dev/null 2>&1 || true
  docker exec notification-service-postgres-1 psql -U notifications -d notifications -qc "drop database if exists $DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker exec notification-service-postgres-1 psql -U notifications -d notifications -qc "create database $DB"
if [ -n "${EMBEDDED_REDIS:-}" ]; then
  redis_env=(-e START_EMBEDDED_REDIS=true -e REDIS_URL=redis://127.0.0.1:6379)  # the cap then covers Redis as well
else
  docker run -d --name "$REDIS" -p 6390:6379 redis:7-alpine >/dev/null
  redis_env=(-e REDIS_URL=redis://host.docker.internal:6390)
fi

limits=()
[ -n "$CPUS" ] && limits+=(--cpus="$CPUS")
[ -n "$MEM" ] && limits+=(--memory="$MEM")
docker run -d --name "$APP" -p 3200:3000 "${limits[@]}" --add-host host.docker.internal:host-gateway \
  -e DATABASE_URL="postgres://notifications:notifications@host.docker.internal:5433/$DB" \
  "${redis_env[@]}" -e STREAM_TOKEN_SECRET=loadtest-secret-loadtest-secret-loadtest \
  -e RUN_WORKER=true -e WORKER_CONCURRENCY=10 -e RATE_LIMIT_PER_MINUTE=10000000 -e RATE_LIMIT_BURST=1000000 \
  notification-service:local >/dev/null

for _ in $(seq 1 60); do curl -sf http://localhost:3200/ready >/dev/null && break; sleep 1; done
curl -sf http://localhost:3200/ready >/dev/null || { docker logs "$APP" | tail -20; exit 1; }

KEY=$(DATABASE_URL="$PG/$DB" npx tsx src/scripts/provision-tenant.ts load 2>&1 | grep -o 'ntf_live_[A-Za-z0-9_-]*')
echo "== rate=${RATE}/s duration=${DURATION} cpus=${CPUS:-unlimited} memory=${MEM:-unlimited} redis=$([ -n "${EMBEDDED_REDIS:-}" ] && echo embedded || echo separate)"
if [ -n "${RAW_OUT:-}" ]; then
  : > "$RAW_OUT"; : > "$RAW_OUT.stats"
  # CPU/memory of the app and the k6 container every ~2 s, so the load generator's own cost is on record.
  ( while true; do for c in "$APP" "$K6"; do docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' "$c" 2>/dev/null | sed "s/^/$(date +%T) /" >> "$RAW_OUT.stats"; done; sleep 1; done ) &
  SAMPLER=$!
fi
docker run --rm -i --name "$K6" --add-host host.docker.internal:host-gateway   -e API_KEY="$KEY" -e BASE_URL=http://host.docker.internal:3200 -e RATE="$RATE" -e DURATION="$DURATION"   -v "$(pwd -W)/loadtest:/loadtest" grafana/k6 run --quiet /loadtest/notifications.js 2>&1 | tee "${RAW_OUT:-/dev/null}" | grep -E "http_req_duration|http_req_failed|checks|notifications_accepted|dropped_iterations|end_to_end|ERRO|WARN|threshold" || true
if [ -n "${RAW_OUT:-}" ]; then
  { echo "== postgres, counted after the run (throwaway database $DB)"
    docker exec notification-service-postgres-1 psql -U notifications -d "$DB" -Atc "select 'notifications ' || status || ' ' || count(*) from notifications group by status order by status"
    docker exec notification-service-postgres-1 psql -U notifications -d "$DB" -Atc "select 'attempts ' || channel || ' ' || status || ' ' || n from (select channel, status, count(*) n from delivery_attempts group by channel, status) t order by 1"; } | tee -a "$RAW_OUT"
fi
echo "== app container: $(docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}}' "$APP")"
