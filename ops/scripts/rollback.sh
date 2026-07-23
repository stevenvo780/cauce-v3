#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
action=${1:-schema}
if [[ "$action" != runtime ]]; then
  printf 'schema rollback is forbidden: restore a verified PostgreSQL backup into a new V3 database.\n' >&2
  printf 'for an image-only rollback use: rollback.sh runtime\n' >&2
  printf 'for an alias cutover rollback use: cutover-rollback.sh host-native|container ALIAS SNAPSHOT.json\n' >&2
  exit 2
fi
: "${CAUCE_PREVIOUS_RUNTIME_IMAGE:?set an immutable previous runtime image digest}"
: "${CAUCE_ENV_FILE:?set the private production compose env file}"
[[ "$CAUCE_PREVIOUS_RUNTIME_IMAGE" == *@sha256:* ]] || { printf 'runtime rollback requires an image pinned by sha256 digest\n' >&2; exit 2; }
[[ ${CAUCE_ROLLBACK_CONFIRM:-} == "runtime-only:$CAUCE_PREVIOUS_RUNTIME_IMAGE" ]] || {
  printf 'set CAUCE_ROLLBACK_CONFIRM=runtime-only:%s\n' "$CAUCE_PREVIOUS_RUNTIME_IMAGE" >&2
  exit 2
}
export CAUCE_RUNTIME_IMAGE="$CAUCE_PREVIOUS_RUNTIME_IMAGE"
CAUCE_ENV_FILE="$CAUCE_ENV_FILE" "$ROOT/scripts/compose.sh" prod pull gateway dispatcher outbox-metrics
CAUCE_ENV_FILE="$CAUCE_ENV_FILE" "$ROOT/scripts/compose.sh" prod up -d --no-build --no-deps gateway dispatcher outbox-metrics
CAUCE_ENV_FILE="$CAUCE_ENV_FILE" "$ROOT/scripts/compose.sh" prod up -d --no-build --wait
CAUCE_ENV_FILE="$CAUCE_ENV_FILE" "$ROOT/scripts/stack-health.sh" prod
printf 'runtime image rollback completed; schema, data, adapters and V2 were not changed\n'
