#!/usr/bin/env bash
# Runs the release gate on the checked-out commit and writes a receipt bound to its SHA.
# The receipt lives outside the tree because it cannot be part of the commit it certifies.
# Gates run in parallel lanes: lane 0 is this checkout and every other lane is a disposable
# worktree of the same commit with its own node_modules, so no gate sees another's dist/ or artifacts.
set -euo pipefail

GATES=(typecheck lint test coverage:ratchet qa:testcontainers qa:layout qa:runtime-packaging ops:validate arch:validate)
# With more than one lane the two long poles start first and the rest cheapest first.
LAUNCH_ORDER=(test coverage:ratchet arch:validate typecheck qa:runtime-packaging lint qa:layout ops:validate qa:testcontainers)
ORPHAN_SWEEP=(python3 -m pytest ops/tests/test_fleet_orphan_sweep.py ops/tests/test_fleet_executor_container.py -q --tb=line)

die() { echo "release-gates: $*" >&2; exit 1; }

commands() {
  printf '%s\n' "${ORPHAN_SWEEP[*]}"
  printf 'pnpm %s\n' "${GATES[@]}"
}

# One lane per 8 CPUs and per 16 GiB available: test and coverage each drive vitest pools and Postgres.
default_jobs() {
  local cpus mem_kib jobs
  cpus=$(nproc 2>/dev/null || echo 1)
  mem_kib=$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)
  jobs=$(( cpus / 8 ))
  (( ${mem_kib:-0} / 16777216 >= jobs )) || jobs=$(( ${mem_kib:-0} / 16777216 ))
  (( jobs >= 1 )) || jobs=1
  echo "$jobs"
}

wanted_jobs() {
  local jobs="${CAUCE_RELEASE_GATES_JOBS:-$(default_jobs)}"
  [[ "$jobs" =~ ^[1-9][0-9]{0,3}$ ]] || die "CAUCE_RELEASE_GATES_JOBS debe ser un entero entre 1 y 9999 (es '$jobs')"
  (( jobs <= ${#GATES[@]} )) || jobs=${#GATES[@]}
  echo "$jobs"
}

[ "$(printf '%s\n' "${LAUNCH_ORDER[@]}" | sort)" = "$(printf '%s\n' "${GATES[@]}" | sort)" ] \
  || die "LAUNCH_ORDER no es una permutacion de GATES"

case "${1:-}" in
  --list) commands; exit 0 ;;
  --concurrencia) wanted_jobs; exit 0 ;;
  "") ;;
  *) echo "uso: scripts/release-gates.sh [--list | --concurrencia]" >&2; exit 2 ;;
esac

(( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )) \
  || die "hace falta bash >= 5.1 (wait -n -p); es $BASH_VERSION"
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT_ROOT="${CAUCE_RELEASE_GATES_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cauce-v3/release-gates}"
[[ "$OUT_ROOT" = /* ]] || die "CAUCE_RELEASE_GATES_DIR debe ser una ruta absoluta"
LANES_ROOT="${CAUCE_RELEASE_GATES_LANES_DIR:-$(dirname "$REPO")/.cauce-release-gates-lanes}"
[[ "$LANES_ROOT" = /* ]] || die "CAUCE_RELEASE_GATES_LANES_DIR debe ser una ruta absoluta"
case "$LANES_ROOT/" in "$REPO"/*) die "los carriles no pueden vivir dentro del arbol que certifican: $LANES_ROOT" ;; esac
for tool in pnpm python3 shellcheck ruff git setsid; do
  command -v "$tool" >/dev/null || die "falta $tool en PATH (activa ~/.venvs/cauce-qa); no es un fallo de codigo"
done
JOBS="$(wanted_jobs)"
ORDER=("${GATES[@]}")
[ "$JOBS" = 1 ] || ORDER=("${LAUNCH_ORDER[@]}")

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

LANE_DIRS=("$REPO")
FREE_LANES=()
LANES=""
LANES_ROOT_CREATED=""
declare -A NUMBER=() LOG_OF=() STARTED_AT=() RESULT=() RUN_DISPLAY=() RUN_LANE=() RUN_BEGAN=()
NUMBER["${ORPHAN_SWEEP[*]}"]=00
for index in "${!GATES[@]}"; do NUMBER["pnpm ${GATES[$index]}"]="$(printf '%02d' $((index + 1)))"; done
FAILED=""

remove_lanes() {
  local lane dir
  [ -n "$LANES" ] || return 0
  for lane in "${!LANE_DIRS[@]}"; do
    [ "$lane" != 0 ] || continue
    dir="${LANE_DIRS[$lane]}"
    [ ! -d "$dir/ops/artifacts" ] || cp -a "$dir/ops/artifacts" "$OUT/carril-$lane-ops-artifacts" 2>/dev/null || true
    git -C "$REPO" worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"
  done
  rm -rf "$LANES"
  [ -z "$LANES_ROOT_CREATED" ] || rmdir "$LANES_ROOT" 2>/dev/null || true
}

on_exit() {
  local code=$?
  remove_lanes
  exit "$code"
}

on_signal() {
  local pid watchdog
  trap - INT TERM HUP
  echo "release-gates: interrumpido; termino ${#RUN_DISPLAY[@]} paso(s) en curso y no emito recibo (logs en $OUT)" >&2
  for pid in "${!RUN_DISPLAY[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  (sleep 10; for pid in "${!RUN_DISPLAY[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done) &
  watchdog=$!
  for pid in "${!RUN_DISPLAY[@]}"; do wait "$pid" 2>/dev/null || true; done
  kill "$watchdog" 2>/dev/null || true
  for pid in "${!RUN_DISPLAY[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  exit 130
}
trap on_exit EXIT
trap on_signal INT TERM HUP

prepare_lane() {
  local index="${#LANE_DIRS[@]}" dir log
  if [ -z "$LANES" ]; then
    [ -d "$LANES_ROOT" ] || LANES_ROOT_CREATED=1
    if ! mkdir -p "$LANES_ROOT" || ! LANES="$(mktemp -d "$LANES_ROOT/${COMMIT:0:12}-XXXXXX")"; then
      LANES=""
      echo "release-gates: AVISO: no pude crear carriles en $LANES_ROOT; sigo con ${#LANE_DIRS[@]} carril(es)" >&2
      return 1
    fi
  fi
  dir="$LANES/carril-$index"
  log="$OUT/carril-$index.log"
  echo "== carril $index: worktree desechable de $COMMIT en $dir"
  if git worktree add --detach "$dir" "$COMMIT" >"$log" 2>&1 </dev/null \
    && (cd "$dir" && pnpm install --frozen-lockfile --prefer-offline) >>"$log" 2>&1 </dev/null \
    && [ "$(git -C "$dir" rev-parse HEAD)" = "$COMMIT" ] \
    && [ -z "$(git -C "$dir" status --porcelain)" ]; then
    LANE_DIRS+=("$dir")
    FREE_LANES+=("$index")
    return 0
  fi
  git worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"
  echo "release-gates: AVISO: el carril $index no quedo listo (log en $log); sigo con ${#LANE_DIRS[@]} carril(es)" >&2
  return 1
}

launch() {
  local display="$1" slug="$2" lane="$3" pid log
  shift 3
  log="${NUMBER[$display]}-$slug.log"
  LOG_OF["$display"]="$log"
  STARTED_AT["$display"]="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  (cd "${LANE_DIRS[$lane]}" && exec setsid -w "$@") >"$OUT/$log" 2>&1 </dev/null &
  pid=$!
  RUN_DISPLAY[$pid]="$display"
  RUN_LANE[$pid]="$lane"
  RUN_BEGAN[$pid]="$(date +%s)"
  echo "== $display: arranca en el carril $lane"
}

reap() {
  local pid="" code=0 display lane seconds log
  wait -n -p pid || code=$?
  [ -n "$pid" ] || die "wait no devolvio ningun paso con ${#RUN_DISPLAY[@]} en curso"
  display="${RUN_DISPLAY[$pid]}"
  lane="${RUN_LANE[$pid]}"
  seconds=$(( $(date +%s) - RUN_BEGAN[$pid] ))
  unset "RUN_DISPLAY[$pid]" "RUN_LANE[$pid]" "RUN_BEGAN[$pid]"
  FREE_LANES+=("$lane")
  log="${LOG_OF[$display]}"
  RESULT["$display"]="$code $(sha256sum "$OUT/$log" | cut -d' ' -f1) $seconds $log $lane ${STARTED_AT[$display]}"
  echo "== $display: exit $code (${seconds}s, carril $lane) -> $OUT/$log"
  [ "$code" = 0 ] && return 0
  tail -n 40 "$OUT/$log" >&2
  [ -n "$FAILED" ] || FAILED="$display"
  [ "${#RUN_DISPLAY[@]}" = 0 ] \
    || echo "release-gates: ROJO en $display; no arranco mas pasos y espero a los ${#RUN_DISPLAY[@]} en curso (Ctrl-C los termina sin recibo)" >&2
}

if [ "$JOBS" = 1 ]; then
  echo "release-gates: $COMMIT en secuencia en este checkout (CAUCE_RELEASE_GATES_JOBS=1)"
else
  echo "release-gates: $COMMIT con hasta $JOBS carriles; los extra son worktrees desechables en $LANES_ROOT"
fi
launch "${ORPHAN_SWEEP[*]}" orphan-sweep 0 "${ORPHAN_SWEEP[@]}"
reap
PENDING=()
if [ -z "$FAILED" ]; then
  PENDING=("${ORDER[@]}")
  while [ "${#LANE_DIRS[@]}" -lt "$JOBS" ] && prepare_lane; do :; done
fi
while :; do
  while [ -z "$FAILED" ] && [ "${#PENDING[@]}" -gt 0 ] && [ "${#FREE_LANES[@]}" -gt 0 ]; do
    lane="${FREE_LANES[0]}"
    FREE_LANES=("${FREE_LANES[@]:1}")
    gate="${PENDING[0]}"
    PENDING=("${PENDING[@]:1}")
    launch "pnpm $gate" "${gate//:/-}" "$lane" pnpm "$gate"
  done
  [ "${#RUN_DISPLAY[@]}" -gt 0 ] || break
  reap
done
FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

[ "$(git rev-parse HEAD)" = "$COMMIT" ] || die "HEAD cambio durante el gate; recibo no emitido (logs en $OUT)"
DIRTY="$(git status --porcelain)"
[ -z "$DIRTY" ] || die "los gates modificaron el arbol; recibo no emitido (logs en $OUT):"$'\n'"$DIRTY"
for lane in "${!LANE_DIRS[@]}"; do
  [ "$lane" != 0 ] || continue
  [ "$(git -C "${LANE_DIRS[$lane]}" rev-parse HEAD)" = "$COMMIT" ] \
    || die "HEAD cambio en el carril $lane durante el gate; recibo no emitido (logs en $OUT)"
  DIRTY="$(git -C "${LANE_DIRS[$lane]}" status --porcelain)"
  [ -z "$DIRTY" ] || die "los gates modificaron el carril $lane; recibo no emitido (logs en $OUT):"$'\n'"$DIRTY"
done

ROWS=()
while IFS= read -r display; do
  [ -n "${RESULT[$display]:-}" ] || continue
  read -r code digest seconds log lane began <<<"${RESULT[$display]}"
  ROWS+=("$display" "$code" "$digest" "$seconds" "$log" "$lane" "$began")
done < <(commands)

python3 - "$OUT/recibo.json" "$COMMIT" "$TREE" "$STARTED" "$FINISHED" "$JOBS" "${#LANE_DIRS[@]}" "${ROWS[@]}" <<'PY'
import json
import os
import re
import sys

path, commit, tree, started, finished, jobs, lanes, *rows = sys.argv[1:]
ROW = re.compile(r"^\s+(\S+)\s+(\S+)\s+base (\d+(?:\.\d+)?)%\s+medido (\d+(?:\.\d+)?)%")
MERGED = re.compile(r"CIFRA FUSIONADA\s+lineas \d+/\d+ = (\d+(?:\.\d+)?)%")


def coverage(log):
    try:
        with open(os.path.join(os.path.dirname(path), log), encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError:
        return None
    start = text.rfind("trinquete de cobertura (lineas por paquete")
    if start < 0:
        return None
    packages = {}
    for line in text[start:].splitlines()[1:]:
        if not line.strip():
            break
        match = ROW.match(line)
        if match:
            packages[match[1]] = {"estado": match[2], "base": float(match[3]), "medido": float(match[4])}
    merged = MERGED.search(text)
    return {"paquetes": packages, "lineas_fusionadas_pct": float(merged[1]) if merged else None}


commands = [
    {"cmd": cmd, "exit": int(code), "log_sha256": digest, "duracion": int(seconds), "log": log,
     "carril": int(lane), "inicio": began}
    for cmd, code, digest, seconds, log, lane, began in zip(*[iter(rows)] * 7)
]
ratchet = next((command for command in commands if command["cmd"] == "pnpm coverage:ratchet"), None)
receipt = {
    "commit": commit, "tree": tree, "comandos": commands, "inicio": started, "fin": finished,
    "concurrencia": int(jobs), "carriles": int(lanes),
    "cobertura": coverage(ratchet["log"]) if ratchet else None,
}
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
