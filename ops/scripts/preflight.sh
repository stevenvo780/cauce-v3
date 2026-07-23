#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
alias_name=${1:?usage: preflight.sh ALIAS SNAPSHOT.json}
snapshot=${2:?usage: preflight.sh ALIAS SNAPSHOT.json}
python3 "$ROOT/scripts/validate-manifests.py"
python3 "$ROOT/scripts/generate-units.py" --alias "$alias_name" --output "$ROOT/generated/systemd" >/dev/null
node "$ROOT/scripts/migration-gate.mjs" preflight "$snapshot" "$alias_name"
printf 'preflight passed; no service or V2 state was changed\n'
