#!/usr/bin/env bash
# Deploys the Redis test containers (docker-compose.yml), seeds fixed keys of
# every value type, and runs the live integration tests in
# `src-tauri/src/commands/redis.rs` (#[ignore]'d there — no live-server
# dependency belongs in the default `cargo test` run) against them.
#
# Usage:
#   scripts/test-redis-docker.sh          # up, seed, test (containers stay up)
#   scripts/test-redis-docker.sh --down   # tear down the containers and exit
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "--down" ]]; then
  echo "==> Stopping Redis test containers"
  docker compose down redis redis-auth
  exit 0
fi

echo "==> Starting Redis test containers (redis:6379, redis-auth:6380)"
docker compose up -d redis redis-auth

wait_healthy() {
  local service="$1" tries=0
  echo "==> Waiting for '$service' to become healthy"
  while true; do
    local cid status
    cid="$(docker compose ps -q "$service")"
    status="$(docker inspect --format='{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "starting")"
    if [[ "$status" == "healthy" ]]; then
      echo "    $service is healthy."
      return 0
    fi
    tries=$((tries + 1))
    if [[ "$tries" -ge 30 ]]; then
      echo "    $service did not become healthy in time (status: $status)." >&2
      docker compose logs "$service" >&2
      exit 1
    fi
    sleep 1
  done
}
wait_healthy redis
wait_healthy redis-auth

echo "==> Seeding fixed key set into 'redis' (flushed first, so re-runs are deterministic)"
docker compose exec -T redis redis-cli --no-raw <<'EOF' > /dev/null
FLUSHALL
SET greeting "hello world"
EXPIRE greeting 3600
HSET user:1 name Ada plan pro
RPUSH mylist a b c
SADD myset x y z
ZADD myzset 1 alice 2 bob
EOF

echo "==> Running live integration tests (cargo test -- --ignored)"
# --test-threads=1: these tests share one live, mutable keyset in the same
# container — running them concurrently races on shared keys (e.g. one test
# reading "greeting" mid-write by another). Serial execution matches how few
# of them there are (3) and how cheap each one is.
(
  cd src-tauri
  cargo test --lib commands::redis:: -- --ignored --test-threads=1 --nocapture
)

echo
echo "All Redis integration tests passed."
echo "Containers are still running — 'redis' on 127.0.0.1:6379 (no auth),"
echo "'redis-auth' on 127.0.0.1:6380 (password: rdSQL_dev_Passw0rd!)."
echo "Tear down with: scripts/test-redis-docker.sh --down"
