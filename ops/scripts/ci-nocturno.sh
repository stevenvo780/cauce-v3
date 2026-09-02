#!/usr/bin/env bash
set -euo pipefail

# The working line is `dev`; `main` lags behind it, so gating on `main` would gate stale code.
CAUCE_CI_RAMA=${CAUCE_CI_RAMA:-dev}

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# ops/artifacts is git-ignored and lives in the root-owned tree: /var/tmp is world-writable and a
# local user could plant a fake summary between runs.
RESUMEN=${CAUCE_CI_RESUMEN:-$ROOT/ops/artifacts/ci-nocturno-ultimo.json}

# `cobertura` re-runs the whole matrix under instrumentation, so it goes after `test` and never
# into the per-commit gate. `audit` runs the allowlist gate instead of `qa:audit`: raw
# `pnpm audit --audit-level=high` reddens forever on the first high without an upstream patch.
PASOS_NOMBRE=(install typecheck lint test cobertura audit layout ops-validate)
PASOS_CMD=(
  'pnpm install --frozen-lockfile'
  'pnpm typecheck'
  'pnpm lint'
  'CAUCE_REQUIRE_TESTCONTAINERS=1 pnpm test'
  'node scripts/cobertura.mjs --trinquete'
  'node ops/scripts/auditoria-de-dependencias.mjs'
  'node console/qa/layout-gate.mjs'
  'CAUCE_RELEASE_VALIDATION=1 pnpm ops:validate'
)

case "${1:-}" in
  '') ;;
  --dry-run)
    printf 'plan del CI nocturno (--dry-run: no crea ni ejecuta nada)\n'
    printf '  repo:     %s\n' "$ROOT"
    printf '  rama:     origin/%s\n' "$CAUCE_CI_RAMA"
    printf '  worktree: mktemp -d bajo /var/tmp, --detach y desechable\n'
    printf '  resumen:  %s\n' "$RESUMEN"
    for i in "${!PASOS_NOMBRE[@]}"; do
      printf '  %d. %-12s %s\n' "$((i + 1))" "${PASOS_NOMBRE[$i]}" "${PASOS_CMD[$i]}"
    done
    exit 0
    ;;
  *)
    printf 'uso: ci-nocturno.sh [--dry-run]\n' >&2
    exit 2
    ;;
esac

# shellcheck disable=SC2329
json_texto() {
  local crudo=${1//\\/\\\\}
  printf '%s' "${crudo//\"/\\\"}"
}

# shellcheck disable=SC2329
escribir_resumen() {
  local tmp ultimo coma i
  mkdir -p "$(dirname "$RESUMEN")"
  tmp=$(mktemp "$RESUMEN.XXXXXX")
  ultimo=$((${#PASOS_NOMBRE[@]} - 1))
  {
    printf '{\n'
    printf '  "rama": "%s",\n' "$(json_texto "$CAUCE_CI_RAMA")"
    printf '  "commit": "%s",\n' "$(json_texto "$COMMIT")"
    printf '  "instante": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "estado": "%s",\n' "$ESTADO"
    printf '  "pasos": [\n'
    for i in "${!PASOS_NOMBRE[@]}"; do
      coma=,
      [[ $i -eq $ultimo ]] && coma=''
      printf '    {"nombre": "%s", "comando": "%s", "veredicto": "%s", "segundos": %d}%s\n' \
        "$(json_texto "${PASOS_NOMBRE[$i]}")" "$(json_texto "${PASOS_CMD[$i]}")" \
        "${VEREDICTOS[$i]:-pendiente}" "${SEGUNDOS[$i]:-0}" "$coma"
    done
    printf '  ],\n'
    printf '  "salida": %d\n' "$SALIDA"
    printf '}\n'
  } >"$tmp"
  mv "$tmp" "$RESUMEN"
}

COMMIT=desconocido
ESTADO=incompleto
SALIDA=2
WORKTREE=
VEREDICTOS=()
SEGUNDOS=()

# The summary is written from the trap so an abort (no network, worktree error, SIGTERM of
# TimeoutStartSec) never leaves yesterday's green JSON in place as today's answer.
# shellcheck disable=SC2329
al_salir() {
  local codigo=$?
  if [[ -n $WORKTREE ]]; then
    git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
    git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
  fi
  if [[ $ESTADO != completo ]]; then
    SALIDA=2
    if [[ $codigo -ne 0 ]]; then
      SALIDA=$codigo
    fi
  fi
  escribir_resumen
  printf 'resumen: %s (estado %s, salida %d)\n' "$RESUMEN" "$ESTADO" "$SALIDA"
}
trap al_salir EXIT

cd "$ROOT"
git fetch --prune origin
COMMIT=$(git rev-parse "origin/$CAUCE_CI_RAMA")

WORKTREE=$(mktemp -d /var/tmp/cauce-v3-ci-XXXXXX)
git worktree add --detach "$WORKTREE" "origin/$CAUCE_CI_RAMA"

printf 'CI nocturno sobre origin/%s (%s) en %s\n' "$CAUCE_CI_RAMA" "$COMMIT" "$WORKTREE"

SALIDA=0
# Every step runs even after a failure: a nightly that stops at step 2 hides the rest.
for indice in "${!PASOS_NOMBRE[@]}"; do
  inicio=$SECONDS
  codigo=0
  (cd "$WORKTREE" && eval "${PASOS_CMD[$indice]}") || codigo=$?
  duracion=$((SECONDS - inicio))
  if [[ $codigo -eq 0 ]]; then
    VEREDICTOS+=(ok)
  else
    VEREDICTOS+=(fallo)
    SALIDA=1
  fi
  SEGUNDOS+=("$duracion")
  printf '[%s] %s en %ds (codigo %d)\n' "${PASOS_NOMBRE[$indice]}" "${VEREDICTOS[$indice]}" "$duracion" "$codigo"
done

ESTADO=completo
exit "$SALIDA"
