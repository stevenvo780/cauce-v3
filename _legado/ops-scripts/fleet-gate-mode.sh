#!/usr/bin/env bash
# Único traductor entre un gate final estricto y la pausa temporal, exacta, de Zeus.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mode=${1:?usage: fleet-gate-mode.sh final|maintenance-zeus|bootstrap-legacy}
(($# == 1)) || { printf 'usage: fleet-gate-mode.sh final|maintenance-zeus|bootstrap-legacy\n' >&2; exit 2; }

case "$mode" in
  final)
    exec "$ROOT/scripts/fleet-parity.sh"
    ;;
  maintenance-zeus)
    change_id=${CAUCE_CHANGE_ID:-}
    [[ $change_id =~ ^[A-Za-z0-9._-]+$ ]] || {
      printf 'fleet maintenance gate requires a non-secret CAUCE_CHANGE_ID\n' >&2
      exit 2
    }
    expected="offline:Steven:zeus:$change_id"
    [[ ${CAUCE_MAINTENANCE_CONFIRM:-} == "$expected" ]] || {
      printf 'fleet maintenance gate requires CAUCE_MAINTENANCE_CONFIRM=offline:Steven:zeus:%s\n' "$change_id" >&2
      exit 2
    }
    printf 'fleet maintenance exception active: Steven:zeus must be offline; a later final gate is mandatory\n' >&2
    exec "$ROOT/scripts/fleet-parity.sh" --expect-offline Steven:zeus
    ;;
  bootstrap-legacy)
    change_id=${CAUCE_CHANGE_ID:-}
    [[ $change_id =~ ^[A-Za-z0-9._-]+$ ]] || {
      printf 'fleet legacy bootstrap gate requires a non-secret CAUCE_CHANGE_ID\n' >&2
      exit 2
    }
    expected="offline:Steven:zeus:$change_id"
    [[ ${CAUCE_MAINTENANCE_CONFIRM:-} == "$expected" ]] || {
      printf 'fleet legacy bootstrap gate requires the exact Zeus maintenance confirmation\n' >&2
      exit 2
    }
    printf 'fleet legacy pre-migration exception active: registry parity remains a post-migration gate\n' >&2
    CAUCE_BOOTSTRAP_LEGACY_FLEET_PROBE=1 exec "$ROOT/scripts/fleet-parity.sh" \
      --legacy-pre-migration --expect-offline Steven:zeus
    ;;
  *)
    printf 'fleet gate mode must be final, maintenance-zeus or bootstrap-legacy\n' >&2
    exit 2
    ;;
esac
