#!/usr/bin/env bash
# Runs the release gate on the checked-out commit and writes a receipt bound to its SHA.
# The receipt lives outside the tree because it cannot be part of the commit it certifies.
set -euo pipefail

GATES=(typecheck lint test coverage:ratchet qa:testcontainers qa:layout qa:runtime-packaging ops:validate arch:validate)

die() { echo "release-gates: $*" >&2; exit 1; }

case "${1:-}" in
  --list) printf 'pnpm %s\n' "${GATES[@]}"; exit 0 ;;
  "") ;;
  *) echo "uso: scripts/release-gates.sh [--list]" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT_ROOT="${CAUCE_RELEASE_GATES_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cauce-v3/release-gates}"
[[ "$OUT_ROOT" = /* ]] || die "CAUCE_RELEASE_GATES_DIR debe ser una ruta absoluta"
for tool in pnpm python3 shellcheck ruff; do
  command -v "$tool" >/dev/null || die "falta $tool en PATH (activa ~/.venvs/cauce-qa); no es un fallo de codigo"
done

# Release mode, as in ops/scripts/ci-nocturno.sh: missing Docker or testcontainers fail instead of skipping.
export CAUCE_RELEASE_VALIDATION=1 CAUCE_REQUIRE_TESTCONTAINERS=1

cd "$REPO"
[ -z "$(git status --porcelain)" ] || die "el arbol no esta limpio: el recibo certificaria algo distinto del commit"
COMMIT="$(git rev-parse HEAD)"
TREE="$(git rev-parse 'HEAD^{tree}')"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT="$OUT_ROOT/$COMMIT-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_ROOT"
mkdir -m 700 "$OUT" || die "no pude crear $OUT"

RESULTS=()
FAILED=""
for index in "${!GATES[@]}"; do
  gate="${GATES[$index]}"
  log="$(printf '%02d' $((index + 1)))-${gate//:/-}.log"
  began="$(date +%s)"
  code=0
  pnpm "$gate" >"$OUT/$log" 2>&1 </dev/null || code=$?
  seconds=$(( $(date +%s) - began ))
  RESULTS+=("pnpm $gate" "$code" "$(sha256sum "$OUT/$log" | cut -d' ' -f1)" "$seconds" "$log")
  echo "== pnpm $gate: exit $code (${seconds}s) -> $OUT/$log"
  if [ "$code" != 0 ]; then
    tail -n 40 "$OUT/$log" >&2
    FAILED="pnpm $gate"
    break
  fi
done
FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

[ "$(git rev-parse HEAD)" = "$COMMIT" ] || die "HEAD cambio durante el gate; recibo no emitido (logs en $OUT)"
DIRTY="$(git status --porcelain)"
[ -z "$DIRTY" ] || die "los gates modificaron el arbol; recibo no emitido (logs en $OUT):"$'\n'"$DIRTY"

python3 - "$OUT/recibo.json" "$COMMIT" "$TREE" "$STARTED" "$FINISHED" "${RESULTS[@]}" <<'PY'
import json
import os
import sys

path, commit, tree, started, finished, *results = sys.argv[1:]
commands = [
    {"cmd": cmd, "exit": int(code), "log_sha256": digest, "duracion": int(seconds), "log": log}
    for cmd, code, digest, seconds, log in zip(*[iter(results)] * 5)
]
receipt = {"commit": commit, "tree": tree, "comandos": commands, "inicio": started, "fin": finished}
with open(f"{path}.tmp", "w", encoding="utf-8") as handle:
    json.dump(receipt, handle, ensure_ascii=False, indent=1)
    handle.write("\n")
os.replace(f"{path}.tmp", path)
PY

if [ -n "$FAILED" ]; then
  die "ROJO en $FAILED; recibo rojo en $OUT/recibo.json"
fi
echo "VERDE: recibo de $COMMIT en $OUT/recibo.json"
echo "Copialo junto al bundle (fuera del clon) y exporta CAUCE_DEPLOY_GATES_RECEIPT con su ruta absoluta."
