#!/usr/bin/env bash
# Runs the whole backup/restore/migrate e2e suite: the default stack
# (Postgres, MySQL, MariaDB) plus each extra engine profile, one at a time so
# the servers fit in Docker Desktop's default 4 GB.
#
#   e2e/backup/run-all.sh                    # everything
#   e2e/backup/run-all.sh cockroach mssql    # only these profiles (+ files)
set -euo pipefail
cd "$(dirname "$0")/../.."
compose="docker compose -f e2e/backup/docker-compose.yml"
vitest="npx vitest run -c e2e/vitest.config.ts"
profiles=("${@:-cockroach yugabyte tidb mssql}")
read -r -a profiles <<<"${profiles[*]}"
failed=()

engine_for() {
  case "$1" in
    cockroach) echo cockroachdb ;;
    yugabyte) echo yugabytedb ;;
    *) echo "$1" ;;
  esac
}

echo "== default stack: postgres, mysql, mariadb (+ sqlite, duckdb files)"
$compose up -d --wait --wait-timeout 900
E2E_ENGINES=sqlite,duckdb $vitest || failed+=("default")

for p in "${profiles[@]}"; do
  echo "== $p"
  $compose --profile "$p" up -d --wait --wait-timeout 900 "$p"
  E2E_ENGINES="$(engine_for "$p")" $vitest e2e/backup/engines.e2e.test.tsx $([ "$p" = mssql ] && echo e2e/backup/migrate.e2e.test.tsx) || failed+=("$p")
  $compose --profile "$p" rm -sfv "$p" >/dev/null
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "All e2e suites passed."
