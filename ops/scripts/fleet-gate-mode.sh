#!/usr/bin/env bash
# Único traductor entre un gate final estricto y la pausa temporal, exacta, de Zeus.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mode=${1:?usage: fleet-gate-mode.sh final|maintenance-zeus}
(($# == 1)) || { printf 'usage: fleet-gate-mode.sh final|maintenance-zeus\n' >&2; exit 2; }

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
  *)
    printf 'fleet gate mode must be final or maintenance-zeus\n' >&2
    exit 2
    ;;
esac
