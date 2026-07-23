#!/usr/bin/env bash
set -euo pipefail

OPS=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT="$OPS/.."
artifact_dir=${CAUCE_AUTHENTIC_ARTIFACT_DIR:-"$OPS/artifacts/compose-authentic"}

node "$OPS/harness/authentic-healthchecks.test.mjs"
command -v docker >/dev/null 2>&1 || { printf 'compose-authentic unavailable: docker is missing\n' >&2; exit 127; }
command -v openssl >/dev/null 2>&1 || { printf 'compose-authentic requires OpenSSL for ephemeral test PKI\n' >&2; exit 127; }
if ! docker compose version >/dev/null 2>&1; then
  if [[ ${CAUCE_RELEASE_VALIDATION:-0} == 1 ]]; then
    printf 'compose-authentic release evidence requires Docker Compose v2\n' >&2
    exit 127
  fi
  printf 'Docker Compose v2 unavailable; running honest docker-run runtime-authentic fallback\n'
  exec "$OPS/scripts/smoke-runtime-authentic.sh"
fi

runtime_image=${CAUCE_AUTHENTIC_RUNTIME_IMAGE:-cauce-v3-authentic-runtime:local}
helper_image=${CAUCE_AUTHENTIC_HELPER_IMAGE:-cauce-v3-authentic-helper:local}
build_args=()
if [[ -n ${CAUCE_NODE_BASE_IMAGE:-} ]]; then build_args+=(--build-arg "CAUCE_NODE_BASE=$CAUCE_NODE_BASE_IMAGE"); fi
if ! docker image inspect "$runtime_image" >/dev/null 2>&1 || [[ ${CAUCE_AUTHENTIC_REBUILD:-1} == 1 ]]; then
  docker build --help >/dev/null 2>&1 || { printf 'runtime image is absent and docker build is unavailable\n' >&2; exit 127; }
  docker build "${build_args[@]}" --target runtime -t "$runtime_image" -f "$PROJECT/deploy/Dockerfile" "$PROJECT"
fi
if ! docker image inspect "$helper_image" >/dev/null 2>&1 || [[ ${CAUCE_AUTHENTIC_REBUILD:-1} == 1 ]]; then
  docker build --help >/dev/null 2>&1 || { printf 'helper image is absent and docker build is unavailable\n' >&2; exit 127; }
  docker build "${build_args[@]}" --target authentic-harness -t "$helper_image" -f "$PROJECT/deploy/Dockerfile" "$PROJECT"
fi

mkdir -p "$OPS/.test-state"
state=$(mktemp -d "$OPS/.test-state/compose-authentic.XXXXXX")
mkdir -p "$state/fixtures" "$state/router" "$state/v2" "$state/v3"
export CAUCE_AUTHENTIC_FIXTURE_DIR="$state/fixtures"
export CAUCE_AUTHENTIC_ROUTER_DIR="$state/router"
export CAUCE_AUTHENTIC_V2_DIR="$state/v2"
export CAUCE_AUTHENTIC_V3_DIR="$state/v3"
export CAUCE_AUTHENTIC_RUNTIME_IMAGE="$runtime_image"
export CAUCE_AUTHENTIC_HELPER_IMAGE="$helper_image"
export CAUCE_AUTHENTIC_GATEWAY_PORT=${CAUCE_AUTHENTIC_GATEWAY_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as value:
    value.bind(('127.0.0.1', 0)); print(value.getsockname()[1])
PY
)}
export CAUCE_AUTHENTIC_CONTROL_PORT=${CAUCE_AUTHENTIC_CONTROL_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as value:
    value.bind(('127.0.0.1', 0)); print(value.getsockname()[1])
PY
)}
export CAUCE_AUTHENTIC_UNIX_CONTROL_PORT=${CAUCE_AUTHENTIC_UNIX_CONTROL_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as value:
    value.bind(('127.0.0.1', 0)); print(value.getsockname()[1])
PY
)}
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-"cauce-authentic-$$"}
export CAUCE_COMPOSE_TARGET=authentic CAUCE_FAULT_CONFIRM=ephemeral-only CAUCE_FAULT_DRIVER=compose

cleanup() {
  "$OPS/scripts/compose.sh" authentic down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$state"
}
trap cleanup EXIT

CAUCE_FIXTURE_DIR="$state/fixtures" CAUCE_ROUTER_DIR="$state/router" \
CAUCE_V2_SOCKET_DIR="$state/v2" CAUCE_V3_SOCKET_DIR="$state/v3" \
node "$OPS/harness/authentic-fixture-init.mjs" >/dev/null

"$OPS/scripts/compose.sh" authentic up -d --no-build --wait
image_digest=$(docker image inspect --format '{{.Id}}' "$runtime_image")
source_digest=$(python3 "$OPS/scripts/source-digest.py")
deployment="$state/deployment.json"
services=(gateway dispatcher relay-worker telegram-bridge shadow-router)
rows="$state/deployment.tsv"
: >"$rows"
for service in "${services[@]}"; do
  container=$("$OPS/scripts/compose.sh" authentic ps -q "$service")
  [[ -n $container ]] || { printf 'compose-authentic service is absent: %s\n' "$service" >&2; exit 1; }
  deployed=$(docker inspect --format '{{.Image}}' "$container")
  [[ $deployed == "$image_digest" ]] || { printf 'compose-authentic image mismatch for %s\n' "$service" >&2; exit 1; }
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

CAUCE_AUTHENTIC_MODE=compose-authentic \
CAUCE_IMAGE_DIGEST="$image_digest" \
CAUCE_SOURCE_DIGEST="$source_digest" \
CAUCE_DEPLOYMENT_EVIDENCE_FILE="$deployment" \
CAUCE_GATEWAY_PORT="$CAUCE_AUTHENTIC_GATEWAY_PORT" \
CAUCE_EXTERNAL_CONTROL_PORT="$CAUCE_AUTHENTIC_CONTROL_PORT" \
CAUCE_UNIX_CONTROL_PORT="$CAUCE_AUTHENTIC_UNIX_CONTROL_PORT" \
CAUCE_FIXTURE_DIR_HOST="$state/fixtures" \
node "$OPS/harness/authentic-runner.mjs" --artifact-dir "$artifact_dir"
"$OPS/scripts/verify-manifest.sh" "$artifact_dir"
printf 'compose-authentic final-binary evidence: %s\n' "$artifact_dir"
