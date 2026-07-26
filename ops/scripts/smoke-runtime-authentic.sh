#!/usr/bin/env bash
set -euo pipefail

OPS=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT="$OPS/.."
artifact_dir=${CAUCE_AUTHENTIC_ARTIFACT_DIR:-"$OPS/artifacts/runtime-authentic"}
runtime_image=${CAUCE_AUTHENTIC_RUNTIME_IMAGE:-cauce-v3-authentic-runtime:local}
helper_image=${CAUCE_AUTHENTIC_HELPER_IMAGE:-cauce-v3-authentic-helper:local}
postgres_image=${CAUCE_AUTHENTIC_POSTGRES_IMAGE:-postgres:16-alpine}
build_args=()
if [[ -n ${CAUCE_NODE_BASE_IMAGE:-} ]]; then build_args+=(--build-arg "CAUCE_NODE_BASE=$CAUCE_NODE_BASE_IMAGE"); fi
command -v docker >/dev/null 2>&1 || { printf 'runtime-authentic unavailable: docker is missing\n' >&2; exit 127; }
command -v openssl >/dev/null 2>&1 || { printf 'runtime-authentic requires OpenSSL for ephemeral test PKI\n' >&2; exit 127; }
docker info >/dev/null 2>&1 || { printf 'runtime-authentic unavailable: Docker daemon is not reachable\n' >&2; exit 127; }

bind_runtime=0
if [[ ${CAUCE_AUTHENTIC_FORCE_BIND:-0} == 1 ]]; then
  bind_runtime=1
  runtime_image=${CAUCE_NODE_BASE_IMAGE:-node:22-alpine}
  docker image inspect "$runtime_image" >/dev/null 2>&1 || { printf 'forced bind fallback has no local Node base image\n' >&2; exit 127; }
elif ! docker image inspect "$runtime_image" >/dev/null 2>&1 || [[ ${CAUCE_AUTHENTIC_REBUILD:-1} == 1 ]]; then
  if ! docker build --help >/dev/null 2>&1 || \
     ! docker build "${build_args[@]}" --target runtime -t "$runtime_image" -f "$PROJECT/deploy/Dockerfile" "$PROJECT"; then
    bind_runtime=1
    runtime_image=${CAUCE_NODE_BASE_IMAGE:-node:22-alpine}
    docker image inspect "$runtime_image" >/dev/null 2>&1 || {
      printf 'runtime-authentic cannot build and has no local Node base image\n' >&2
      exit 127
    }
    printf 'docker build unavailable; using compiled final binaries as read-only bind mounts (runtime-authentic only)\n'
  fi
fi
if ((bind_runtime == 0)) && { ! docker image inspect "$helper_image" >/dev/null 2>&1 || [[ ${CAUCE_AUTHENTIC_REBUILD:-1} == 1 ]]; }; then
  if ! docker build "${build_args[@]}" --target authentic-harness -t "$helper_image" -f "$PROJECT/deploy/Dockerfile" "$PROJECT"; then
    helper_image=$runtime_image
  fi
elif ((bind_runtime == 1)); then
  helper_image=$runtime_image
fi

prefix=${CAUCE_RUNTIME_PREFIX:-"cauce-runtime-authentic-$$"}
network="$prefix-net"
pg_volume="$prefix-pgdata"
app_volume="$prefix-app"
fixture_volume="$prefix-fixtures"
router_volume="$prefix-router"
v2_volume="$prefix-v2"
v3_volume="$prefix-v3"
mkdir -p "$OPS/.test-state"
state=$(mktemp -d "$OPS/.test-state/runtime-authentic.XXXXXX")
mkdir -p "$state/fixtures" "$state/router" "$state/v2" "$state/v3"
runtime_mounts=()
helper_mounts=()
if ((bind_runtime == 1)); then
  command -v pnpm >/dev/null 2>&1 || { printf 'buildless fallback requires pnpm to compile final binaries\n' >&2; exit 127; }
  pnpm --dir "$PROJECT" build:core >/dev/null
  runtime_root="$state/runtime"
  mkdir -p "$runtime_root/services" "$runtime_root/packages/store/dist" "$runtime_root/packages/protocol" "$runtime_root/deploy"
  for service in gateway dispatcher relay-worker telegram-bridge shadow-router; do
    mkdir -p "$runtime_root/services/$service"
    cp -a "$PROJECT/dist/services/$service/src" "$runtime_root/services/$service/dist"
    cp -a "$PROJECT/services/$service/node_modules" "$runtime_root/services/$service/node_modules"
  done
  cp "$PROJECT/deploy/runtime-store.package.json" "$runtime_root/packages/store/package.json"
  cp -a "$PROJECT/packages/store/node_modules" "$runtime_root/packages/store/node_modules"
  cp -a "$PROJECT/packages/store/migrations" "$runtime_root/packages/store/migrations"
  cp -a "$PROJECT/dist/packages/store/src/." "$runtime_root/packages/store/dist/"
  cp "$PROJECT/packages/protocol/package.json" "$runtime_root/packages/protocol/package.json"
  cp -a "$PROJECT/packages/protocol/node_modules" "$runtime_root/packages/protocol/node_modules"
  cp -a "$PROJECT/packages/protocol/dist" "$runtime_root/packages/protocol/dist"
  cp -a "$PROJECT/deploy/." "$runtime_root/deploy/"
  mkdir -p "$runtime_root/ops"
  cp -a "$PROJECT/ops/harness" "$runtime_root/ops/harness"
  mkdir -p "$runtime_root/ops/scripts"
  cp "$PROJECT/ops/scripts/fault-runtime.sh" "$runtime_root/ops/scripts/fault-runtime.sh"
  mkdir -p "$runtime_root/bin"
  docker create --name "$prefix-cli-source" docker:cli true >/dev/null
  docker cp "$prefix-cli-source:/usr/local/bin/docker" "$runtime_root/bin/docker"
  docker rm "$prefix-cli-source" >/dev/null
  runtime_mounts=(-v "$app_volume:/app:ro")
  helper_mounts=(-v "$app_volume:/app:ro")
fi
gateway_port=${CAUCE_AUTHENTIC_GATEWAY_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as value:
    value.bind(('127.0.0.1', 0)); print(value.getsockname()[1])
PY
)}
control_port=${CAUCE_AUTHENTIC_CONTROL_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as value:
    value.bind(('127.0.0.1', 0)); print(value.getsockname()[1])
PY
)}
unix_control_port=${CAUCE_AUTHENTIC_UNIX_CONTROL_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as value:
    value.bind(('127.0.0.1', 0)); print(value.getsockname()[1])
PY
)}
external_ip=${CAUCE_AUTHENTIC_EXTERNAL_IP:-192.31.253.10}
database_url=postgresql://cauce_authentic@postgres:5432/cauce_authentic

cleanup() {
  if [[ ${CAUCE_KEEP_RUNTIME_STATE:-0} == 1 ]]; then
    printf 'runtime-authentic state retained: prefix=%s state=%s\n' "$prefix" "$state" >&2
    return
  fi
  for service in runner evidence-init cli-source app-init fixture-init socket-init shadow-router telegram-bridge relay-worker dispatcher gateway unix-target fake-external postgres; do
    docker rm -f "$prefix-$service" >/dev/null 2>&1 || true
  done
  for item in "$pg_volume" "$app_volume" "$fixture_volume" "$router_volume" "$v2_volume" "$v3_volume"; do
    docker volume rm "$item" >/dev/null 2>&1 || true
  done
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$state"
}
trap cleanup EXIT

docker network create --internal --subnet 192.31.253.0/24 "$network" >/dev/null
for item in "$pg_volume" "$fixture_volume" "$router_volume" "$v2_volume" "$v3_volume"; do docker volume create "$item" >/dev/null; done
if ((bind_runtime == 1)); then
  docker volume create "$app_volume" >/dev/null
  docker create --name "$prefix-app-init" -v "$app_volume:/app" "$runtime_image" true >/dev/null
  docker cp "$runtime_root/." "$prefix-app-init:/app"
  docker cp "$PROJECT/node_modules" "$prefix-app-init:/app/node_modules"
  docker rm "$prefix-app-init" >/dev/null
fi
CAUCE_FIXTURE_DIR="$state/fixtures" CAUCE_ROUTER_DIR="$state/router" \
CAUCE_V2_SOCKET_DIR="$state/v2" CAUCE_V3_SOCKET_DIR="$state/v3" \
node "$OPS/harness/authentic-fixture-init.mjs" >/dev/null
docker create --name "$prefix-fixture-init" -v "$fixture_volume:/fixtures" "$runtime_image" true >/dev/null
docker cp "$state/fixtures/." "$prefix-fixture-init:/fixtures"
docker rm "$prefix-fixture-init" >/dev/null
docker run --rm --name "$prefix-socket-init" --user 0:0 \
  -v "$router_volume:/sockets/router" -v "$v2_volume:/sockets/v2" -v "$v3_volume:/sockets/v3" \
  --entrypoint /bin/sh "$runtime_image" -c 'chown 1000:1000 /sockets/router /sockets/v2 /sockets/v3 && chmod 700 /sockets/router /sockets/v2 /sockets/v3' >/dev/null

docker run -d --name "$prefix-postgres" --network "$network" --network-alias postgres \
  -e POSTGRES_DB=cauce_authentic -e POSTGRES_USER=cauce_authentic -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$pg_volume:/var/lib/postgresql/data" "$postgres_image" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$prefix-postgres" pg_isready -U cauce_authentic -d cauce_authentic >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$prefix-postgres" pg_isready -U cauce_authentic -d cauce_authentic >/dev/null
docker run --rm --network "$network" --workdir /app "${runtime_mounts[@]}" \
  -e DATABASE_URL="$database_url" -e NODE_ENV=test "$runtime_image" node deploy/migrate.mjs >/dev/null

docker run -d --name "$prefix-fake-external" --network "$network" --ip "$external_ip" \
  --network-alias fake-external --network-alias api.telegram.org --network-alias webhook.test -p "127.0.0.1:$control_port:9080" \
  -e CAUCE_FIXTURE_DIR=/fixtures -e HTTPS_PORT=443 -e CONTROL_PORT=9080 \
  -v "$fixture_volume:/fixtures:ro" --user 0:0 --workdir /app "${helper_mounts[@]}" \
  "$helper_image" node ops/harness/authentic-external-server.mjs >/dev/null
docker run -d --name "$prefix-unix-target" --network "$network" --network-alias unix-target \
  -e CAUCE_V2_TARGET_SOCKET=/sockets/v2/ingress.sock -e CAUCE_V3_TARGET_SOCKET=/sockets/v3/ingress.sock \
  -e CAUCE_ROUTER_SOCKET=/sockets/router/router.sock -e CAUCE_SHADOW_EVENTS_FILE=/fixtures/shadow-events.jsonl -e CONTROL_PORT=9081 \
  -p "127.0.0.1:$unix_control_port:9081" -v "$fixture_volume:/fixtures" -v "$router_volume:/sockets/router" \
  -v "$v2_volume:/sockets/v2" -v "$v3_volume:/sockets/v3" --user 1000:1000 --workdir /app "${helper_mounts[@]}" \
  "$helper_image" node ops/harness/authentic-unix-target.mjs >/dev/null

run_final() {
  local service=$1; shift
  docker run -d --name "$prefix-$service" --network "$network" --network-alias "$service" --user 1000:1000 \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m --workdir /app "${runtime_mounts[@]}" \
    --entrypoint /app/deploy/runtime-entrypoint.sh \
    "$@"
}

run_final gateway -p "127.0.0.1:$gateway_port:8443" -v "$fixture_volume:/fixtures:ro" \
  -e DATABASE_URL="$database_url" -e NODE_ENV=test -e CAUCE_AUTH_PROVIDER=mtls \
  -e CAUCE_MTLS_IDENTITY_FILE=/fixtures/mtls-identities.json -e CAUCE_TLS_CERT_FILE=/fixtures/gateway.crt \
  -e CAUCE_TLS_KEY_FILE=/fixtures/gateway.key -e CAUCE_TLS_CLIENT_CA_FILE=/fixtures/ca.crt \
  -e CAUCE_HEALTH_PORT=8081 -e CAUCE_CONSOLE_ORIGINS=https://console.invalid -e CAUCE_REQUIRE_ACK_CLAIMS=1 \
  -e CAUCE_ACK_DEADLINE_MS=250 -e PORT=8443 \
  "$runtime_image" node services/gateway/dist/main.js >/dev/null
run_final dispatcher -e DATABASE_URL="$database_url" -e NODE_ENV=test -e PORT=8082 \
  -e DISPATCHER_POLL_MS=20 -e CAUCE_ACK_DEADLINE_MS=250 -e ACK_TIMEOUT_MS=250 -e INTERACTIVE_BURST=3 \
  "$runtime_image" node services/dispatcher/dist/main.js >/dev/null
run_final relay-worker -v "$fixture_volume:/fixtures:ro" -e DATABASE_URL="$database_url" -e NODE_ENV=test \
  -e NODE_EXTRA_CA_CERTS=/fixtures/ca.crt -e CAUCE_WEBHOOK_PROVIDER_MODULE=file:///fixtures/webhook-provider.mjs \
  -e CAUCE_RELAY_ALLOWED_ORIGINS=https://webhook.test -e CAUCE_RELAY_ADAPTERS=webhook \
  -e CAUCE_RELAY_POLL_MS=600000 -e NODE_OPTIONS=--no-network-family-autoselection -e PORT=8083 \
  "$runtime_image" node services/relay-worker/dist/main.js >/dev/null
run_final telegram-bridge -v "$fixture_volume:/fixtures:ro" -e DATABASE_URL="$database_url" -e NODE_ENV=test \
  -e NODE_EXTRA_CA_CERTS=/fixtures/ca.crt -e CAUCE_TELEGRAM_CONFIG_FILE=/fixtures/telegram-config.json \
  -e CAUCE_TELEGRAM_ALIASES=jarvis -e PORT=8086 "$runtime_image" node services/telegram-bridge/dist/main.js >/dev/null
run_final shadow-router -v "$router_volume:/sockets/router" -v "$v2_volume:/sockets/v2:ro" -v "$v3_volume:/sockets/v3:ro" \
  -e DATABASE_URL="$database_url" -e NODE_ENV=test -e SHADOW_ROUTER_MODE=shadow -e SHADOW_ROUTER_TENANTS=Steven \
  -e SHADOW_ROUTER_SOCKET=/sockets/router/router.sock -e SHADOW_ROUTER_V2_SOCKET=/sockets/v2/ingress.sock \
  -e SHADOW_ROUTER_V3_SOCKET=/sockets/v3/ingress.sock "$runtime_image" node services/shadow-router/dist/main.js >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$prefix-gateway" node deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready >/dev/null 2>&1 && \
     docker exec "$prefix-dispatcher" node deploy/readiness-probe.mjs http://127.0.0.1:8082/health/ready ready >/dev/null 2>&1 && \
     docker exec "$prefix-relay-worker" node deploy/readiness-probe.mjs http://127.0.0.1:8083/health/ready ready >/dev/null 2>&1 && \
     docker exec "$prefix-telegram-bridge" node deploy/readiness-probe.mjs http://127.0.0.1:8086/health/ready ready >/dev/null 2>&1 && \
     docker exec "$prefix-shadow-router" node deploy/unix-readiness-probe.mjs /sockets/router/router.sock /health/ready ready >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! docker exec "$prefix-gateway" node deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready >/dev/null; then
  for service in gateway dispatcher relay-worker telegram-bridge shadow-router fake-external unix-target; do
    printf '%s status=%s\n' "$service" "$(docker inspect --format '{{.State.Status}}' "$prefix-$service" 2>/dev/null || printf absent)" >&2
    docker logs "$prefix-$service" >&2 || true
  done
  exit 1
fi

image_digest=$(docker image inspect --format '{{.Id}}' "$runtime_image")
# Same domain binding as the Compose-authentic path: runtime sources plus the harness that drives
# the faults. apps/console is outside the runtime domain because it cannot reach the runtime image
# (see ops/scripts/source-digest.py).
source_digest=$(python3 "$OPS/scripts/source-digest.py" --domain runtime)
harness_digest=$(python3 "$OPS/scripts/source-digest.py" --domain harness)
deployment="$state/deployment.json"
rows="$state/deployment.tsv"
: >"$rows"
for service in gateway dispatcher relay-worker telegram-bridge shadow-router; do
  deployed=$(docker inspect --format '{{.Image}}' "$prefix-$service")
  [[ $deployed == "$image_digest" ]] || { printf 'runtime-authentic image mismatch for %s\n' "$service" >&2; exit 1; }
  printf '%s\t%s\n' "$service" "$deployed" >>"$rows"
done
python3 - "$rows" "$deployment" <<'PY'
import json, pathlib, sys
services = []
for line in pathlib.Path(sys.argv[1]).read_text(encoding='utf-8').splitlines():
    name, image = line.split('\t', 1)
    services.append({'name': name, 'imageDigest': image})
pathlib.Path(sys.argv[2]).write_text(json.dumps({'services': services}, indent=2) + '\n', encoding='utf-8')
PY

if ((bind_runtime == 1)); then
  docker create --name "$prefix-evidence-init" -v "$fixture_volume:/fixtures" "$runtime_image" true >/dev/null
  docker cp "$deployment" "$prefix-evidence-init:/fixtures/deployment.json"
  docker rm "$prefix-evidence-init" >/dev/null
  docker create --name "$prefix-runner" --network "$network" --user 0:0 --workdir /app \
    -v "$app_volume:/app:ro" -v "$fixture_volume:/fixtures:ro" -v /var/run/docker.sock:/var/run/docker.sock \
    -e PATH=/app/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    -e CAUCE_AUTHENTIC_MODE=runtime-authentic -e CAUCE_IMAGE_DIGEST="$image_digest" -e CAUCE_SOURCE_DIGEST="$source_digest" \
    -e CAUCE_HARNESS_DIGEST="$harness_digest" \
    -e CAUCE_DEPLOYMENT_EVIDENCE_FILE=/fixtures/deployment.json -e CAUCE_GATEWAY_HOST=gateway -e CAUCE_GATEWAY_PORT=8443 \
    -e CAUCE_EXTERNAL_CONTROL_HOST=fake-external -e CAUCE_EXTERNAL_CONTROL_PORT=9080 \
    -e CAUCE_UNIX_CONTROL_HOST=unix-target -e CAUCE_UNIX_CONTROL_PORT=9081 -e CAUCE_FIXTURE_DIR_HOST=/fixtures \
    -e CAUCE_FAULT_DRIVER=docker-run -e CAUCE_FAULT_CONFIRM=ephemeral-only -e CAUCE_RUNTIME_PREFIX="$prefix" \
    "$runtime_image" node ops/harness/authentic-runner.mjs --artifact-dir /artifacts >/dev/null
  set +e
  docker start -a "$prefix-runner"
  runner_status=$?
  set -e
  mkdir -p "$artifact_dir"
  docker cp "$prefix-runner:/artifacts/." "$artifact_dir"
  ((runner_status == 0)) || exit "$runner_status"
else
  CAUCE_AUTHENTIC_MODE=runtime-authentic CAUCE_IMAGE_DIGEST="$image_digest" CAUCE_SOURCE_DIGEST="$source_digest" \
  CAUCE_HARNESS_DIGEST="$harness_digest" \
  CAUCE_DEPLOYMENT_EVIDENCE_FILE="$deployment" CAUCE_GATEWAY_PORT="$gateway_port" CAUCE_EXTERNAL_CONTROL_PORT="$control_port" \
  CAUCE_UNIX_CONTROL_PORT="$unix_control_port" CAUCE_FIXTURE_DIR_HOST="$state/fixtures" CAUCE_FAULT_DRIVER=docker-run \
  CAUCE_FAULT_CONFIRM=ephemeral-only CAUCE_RUNTIME_PREFIX="$prefix" \
  node "$OPS/harness/authentic-runner.mjs" --artifact-dir "$artifact_dir"
fi
"$OPS/scripts/verify-manifest.sh" "$artifact_dir"
printf 'runtime-authentic docker-run evidence (not release evidence): %s\n' "$artifact_dir"
