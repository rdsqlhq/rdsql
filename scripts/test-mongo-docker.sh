#!/usr/bin/env bash
# Deploys the MongoDB test container (docker-compose.yml), seeds a fixed
# database/collection, and runs the live integration tests in
# `src-tauri/src/commands/mongo.rs` (#[ignore]'d there — no live-server
# dependency belongs in the default `cargo test` run) against it.
#
# Usage:
#   scripts/test-mongo-docker.sh          # up, seed, test (container stays up)
#   scripts/test-mongo-docker.sh --down   # tear down the container and exit
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "--down" ]]; then
  echo "==> Stopping MongoDB test container"
  docker compose down mongo
  exit 0
fi

echo "==> Starting MongoDB test container (mongo:27017)"
docker compose up -d mongo

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
wait_healthy mongo

echo "==> Seeding 'rdsql_test.widgets' (dropped first, so re-runs are deterministic)"
docker compose exec -T mongo mongosh --quiet rdsql_test <<'EOF' > /dev/null
db.widgets.drop();
db.widgets.insertMany([
  { name: "Widget A", qty: 5 },
  { name: "Widget B", qty: 12 },
]);
EOF

echo "==> Running live integration tests (cargo test -- --ignored)"
# --test-threads=1: these tests share one live, mutable collection in the
# same container — running them concurrently would race on shared documents.
(
  cd src-tauri
  cargo test --lib commands::mongo:: -- --ignored --test-threads=1 --nocapture
)

echo
echo "All MongoDB integration tests passed."
echo "Container is still running — 'mongo' on 127.0.0.1:27017 (no auth)."
echo "Tear down with: scripts/test-mongo-docker.sh --down"
