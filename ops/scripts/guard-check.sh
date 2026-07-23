#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
phase=${1:?usage: guard-check.sh watchdog|reconciler ALIAS}
alias_name=${2:?usage: guard-check.sh watchdog|reconciler ALIAS}
[[ $phase == watchdog || $phase == reconciler ]] || { printf 'invalid guard phase\n' >&2; exit 2; }
: "${CAUCE_GATE_CAPTURE_PATH:?set an absolute executable gate snapshot collector}"
[[ $CAUCE_GATE_CAPTURE_PATH == /* && -x $CAUCE_GATE_CAPTURE_PATH ]] || { printf 'gate collector must be an absolute executable\n' >&2; exit 2; }
snapshot=$(mktemp)
trap 'rm -f "$snapshot"' EXIT
"$CAUCE_GATE_CAPTURE_PATH" "$alias_name" "$snapshot" "$phase"
node "$ROOT/scripts/migration-gate.mjs" "$phase" "$snapshot" "$alias_name"
