#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
alias_name=${1:?usage: canary.sh ALIAS SNAPSHOT.json}
snapshot=${2:?usage: canary.sh ALIAS SNAPSHOT.json}
node "$ROOT/scripts/migration-gate.mjs" canary "$snapshot" "$alias_name"
printf 'canary gates passed for %s; hold two lease/retry windows before expansion\n' "$alias_name"
