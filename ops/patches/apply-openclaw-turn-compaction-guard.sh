#!/usr/bin/env bash
# Aplica ops/patches/openclaw-turn-compaction-guard.mjs sobre uno o varios objetivos.
#
#   apply-openclaw-turn-compaction-guard.sh claw claw-miguel      # por docker exec
#   apply-openclaw-turn-compaction-guard.sh --local               # sobre esta máquina
#   OPENCLAW_DIST=/otra/ruta.js apply-openclaw-turn-compaction-guard.sh --local
#
# No reinicia nada: openclaw carga el bundle al arrancar. Ver ops/patches/README.md.
set -euo pipefail

PATCHES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$PATCHES/openclaw-turn-compaction-guard.mjs"
DIST=${OPENCLAW_DIST:-/usr/lib/node_modules/openclaw/dist/agent-command-DimMXeog.js}

if [[ $# -eq 0 ]]; then
  printf 'uso: %s [--local | <contenedor>...]\n' "$(basename "${BASH_SOURCE[0]}")" >&2
  exit 2
fi

# Cada objetivo se reporta por separado y un fallo no detiene al resto: un parche a medias en la
# flota es peor que ninguno, porque el síntoma aparece en unos alias y en otros no.
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
  # El script viaja por stdin y se ejecuta con el node del contenedor: es el único intérprete que
  # con seguridad está ahí, porque es el que corre openclaw.
  if resultado=$(docker exec -i -e "OPENCLAW_DIST=$DIST" "$objetivo" \
      node --input-type=module - < "$SCRIPT" 2>&1); then
    printf '%s: %s\n' "$objetivo" "$resultado"
  else
    printf '%s: ERROR %s\n' "$objetivo" "$resultado" >&2
    estado=1
  fi
done
exit "$estado"
