#!/usr/bin/env bash
# Applies ops/patches/openclaw-turn-compaction-guard.mjs to one or more targets.
#
#   apply-openclaw-turn-compaction-guard.sh claw claw-miguel      # via docker exec
#   apply-openclaw-turn-compaction-guard.sh --local               # on this machine
#   OPENCLAW_DIST=/other/path.js apply-openclaw-turn-compaction-guard.sh --local
#
# It does not restart anything: openclaw loads the bundle at startup. See ops/patches/README.md.
set -euo pipefail

PATCHES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$PATCHES/openclaw-turn-compaction-guard.mjs"
DIST=${OPENCLAW_DIST:-/usr/lib/node_modules/openclaw/dist/agent-command-DimMXeog.js}

if [[ $# -eq 0 ]]; then
  printf 'uso: %s [--local | <contenedor>...]\n' "$(basename "${BASH_SOURCE[0]}")" >&2
  exit 2
fi

# Each target is reported separately and a failure does not halt the rest: a half-applied patch
# across the fleet is worse than none, because the symptom shows up in some aliases and not others.
estado=0
for objetivo in "$@"; do
  if [[ "$objetivo" == "--local" ]]; then
    if resultado=$(OPENCLAW_DIST="$DIST" node "$SCRIPT" 2>&1); then
      printf 'local: %s\n' "$resultado"
    else
      printf 'local: ERROR %s\n' "$resultado" >&2
      estado=1
    fi
    continue
  fi
  # The script travels over stdin and runs with the container's node: it is the only interpreter
  # that is certainly there, because it is the one running openclaw.
  if resultado=$(docker exec -i -e "OPENCLAW_DIST=$DIST" "$objetivo" \
      node --input-type=module - < "$SCRIPT" 2>&1); then
    printf '%s: %s\n' "$objetivo" "$resultado"
  else
    printf '%s: ERROR %s\n' "$objetivo" "$resultado" >&2
    estado=1
  fi
done
exit "$estado"
