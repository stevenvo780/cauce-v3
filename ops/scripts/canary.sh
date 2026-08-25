#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
alias_name=${1:?usage: canary.sh ALIAS BASELINE-SNAPSHOT.json}
baseline=${2:?usage: canary.sh ALIAS BASELINE-SNAPSHOT.json}
(($# == 2)) || { printf 'usage: canary.sh ALIAS BASELINE-SNAPSHOT.json\n' >&2; exit 2; }
[[ $alias_name =~ ^[a-z][a-z0-9-]*$ ]] || { printf 'invalid alias\n' >&2; exit 2; }
[[ -f $baseline && -r $baseline && ! -L $baseline ]] || {
  printf 'canary baseline must be a readable regular non-symlink file\n' >&2
  exit 2
}
: "${CAUCE_GATE_CAPTURE_PATH:?set an absolute executable gate snapshot collector}"
: "${CAUCE_GATE_PROBE_PATH:?set an absolute executable authentic round-trip probe}"
for executable in "$CAUCE_GATE_CAPTURE_PATH" "$CAUCE_GATE_PROBE_PATH"; do
  [[ $executable == /* && -x $executable && ! -L $executable ]] || {
    printf 'canary executable must be absolute, executable and not a symlink\n' >&2
    exit 2
  }
done
umask 077
temporary=$(mktemp -d)
snapshot="$temporary/snapshot.json"
evidence="$temporary/round-trip.json"
trap 'rm -rf "$temporary"' EXIT
"$CAUCE_GATE_PROBE_PATH" "$alias_name" "$evidence"
CAUCE_GATE_BASELINE_FILE="$baseline" CAUCE_GATE_PROBE_EVIDENCE_FILE="$evidence" \
  "$CAUCE_GATE_CAPTURE_PATH" "$alias_name" "$snapshot" canary
node "$ROOT/scripts/migration-gate.mjs" canary "$snapshot" "$alias_name"
printf 'canary gates passed for %s; hold two lease/retry windows before expansion\n' "$alias_name"
