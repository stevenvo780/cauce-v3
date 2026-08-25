#!/usr/bin/env bash
# Capture a sanitized production registry snapshot and compare it with the release inventory.
# The query runs in the immutable runtime image, so this works with both the optional local
# PostgreSQL Compose service and an external TLS PostgreSQL endpoint.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${CAUCE_ENV_FILE:-"$ROOT/config/prod.env"}
snapshot=$(mktemp)
trap 'rm -f "$snapshot"' EXIT

if [[ -n ${CAUCE_FLEET_SNAPSHOT_FILE:-} ]]; then
  [[ ${CAUCE_FLEET_TEST_MODE:-0} == 1 && ${NODE_ENV:-} == test ]] || {
    printf 'fleet parity: supplied snapshots are accepted only in explicit test mode\n' >&2
    exit 2
  }
  [[ -f $CAUCE_FLEET_SNAPSHOT_FILE && -r $CAUCE_FLEET_SNAPSHOT_FILE && ! -L $CAUCE_FLEET_SNAPSHOT_FILE ]] || {
    printf 'fleet parity: CAUCE_FLEET_SNAPSHOT_FILE must be a readable regular non-symlink file\n' >&2
    exit 2
  }
  cp -- "$CAUCE_FLEET_SNAPSHOT_FILE" "$snapshot"
else
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod run --rm --no-deps -T migrator \
    node deploy/fleet-snapshot.mjs >"$snapshot"
fi

args=()
while (($#)); do
  case "$1" in
    --expect-offline|--allow-extra-lease)
      (($# >= 2)) || { printf 'fleet parity: %s requires TENANT:ALIAS\n' "$1" >&2; exit 2; }
      args+=("$1" "$2")
      shift 2
      ;;
    *) printf 'fleet parity: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/fleet-parity.py" \
  --ops-root "$ROOT" --snapshot "$snapshot" "${args[@]}"
