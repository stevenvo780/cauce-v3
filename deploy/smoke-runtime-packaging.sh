#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
runtime_image=${CAUCE_RUNTIME_SMOKE_IMAGE:-cauce-v3-runtime-smoke:local}
postgres_image=${CAUCE_RUNTIME_SMOKE_POSTGRES_IMAGE:-postgres:16-alpine}
rebuild=${CAUCE_RUNTIME_SMOKE_REBUILD:-1}

command -v docker >/dev/null 2>&1 || { printf 'runtime packaging smoke requires Docker\n' >&2; exit 127; }
docker info >/dev/null 2>&1 || { printf 'runtime packaging smoke cannot reach Docker\n' >&2; exit 127; }

case "$rebuild" in
  1)
    build_args=()
    if [[ -n ${CAUCE_NODE_BASE_IMAGE:-} ]]; then
      build_args+=(--build-arg "CAUCE_NODE_BASE=$CAUCE_NODE_BASE_IMAGE")
    fi
    docker build "${build_args[@]}" --target runtime -t "$runtime_image" -f "$ROOT/deploy/Dockerfile" "$ROOT"
    ;;
  0)
    docker image inspect "$runtime_image" >/dev/null 2>&1 || {
      printf 'runtime packaging smoke image is unavailable: %s\n' "$runtime_image" >&2
      exit 2
    }
    ;;
  *)
    printf 'CAUCE_RUNTIME_SMOKE_REBUILD must be 0 or 1\n' >&2
    exit 2
    ;;
esac

configured_user=$(docker image inspect --format '{{.Config.User}}' "$runtime_image")
case "$configured_user" in
  ''|0|0:0|root|root:root)
    printf 'runtime image must configure a non-root user\n' >&2
    exit 1
    ;;
esac

prefix="cauce-runtime-package-$$"
network="$prefix-net"
postgres="$prefix-postgres"
cleanup() {
  docker rm -f "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create --internal "$network" >/dev/null
docker run -d --name "$postgres" --network "$network" --network-alias postgres \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev \
  -e POSTGRES_DB=cauce_smoke \
  -e POSTGRES_USER=cauce_smoke \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$postgres_image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$postgres" pg_isready -U cauce_smoke -d cauce_smoke >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$postgres" pg_isready -U cauce_smoke -d cauce_smoke >/dev/null

# shellcheck disable=SC2054
runtime_flags=(
  --rm
  --network "$network"
  --user 1000:1000
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,size=32m
  --workdir /app
)
docker run "${runtime_flags[@]}" "$runtime_image" node deploy/runtime-package-smoke.mjs
docker run "${runtime_flags[@]}" \
  -e DATABASE_URL=postgresql://cauce_smoke@postgres:5432/cauce_smoke \
  -e NODE_ENV=test \
  "$runtime_image" node deploy/migrate.mjs

migration_count=$(docker exec "$postgres" psql -U cauce_smoke -d cauce_smoke -Atqc \
  'SELECT count(*) FROM schema_migrations')
if [[ ! "$migration_count" =~ ^[1-9][0-9]*$ ]]; then
  printf 'runtime migrator did not apply migrations\n' >&2
  exit 1
fi

printf 'runtime packaging smoke passed: imports, non-root/read-only, PostgreSQL migrator (%s migrations)\n' "$migration_count"
