#!/usr/bin/env bash
# Runs the release gate on the checked-out commit and writes a receipt bound to its SHA.
# The receipt lives outside the tree because it cannot be part of the commit it certifies.
# Gates run in parallel lanes: lane 0 is this checkout and every other lane is a disposable
# worktree of the same commit with its own node_modules, so no gate sees another's dist/ or artifacts.
# test and coverage:ratchet run as N shards (CAUCE_TEST_SHARD=i/N, see scripts/trozos.mjs) plus a
# fusion step that proves the shards ran every test file once and, for coverage, applies the ratchet.
# Fail-fast (default): the first red ends every step in flight - its process group, any process that
# inherited its step token, and the test containers labelled with that token - and writes the red receipt.
set -euo pipefail

GATES=(typecheck lint test coverage:ratchet qa:testcontainers qa:layout qa:runtime-packaging ops:validate arch:validate)
SHARDED=(test coverage:ratchet)
# With more than one lane the long poles start first and the rest cheapest first.
LAUNCH_ORDER=(test coverage:ratchet qa:testcontainers arch:validate typecheck qa:runtime-packaging lint qa:layout ops:validate)
ORPHAN_SWEEP=(python3 -m pytest ops/tests/test_fleet_orphan_sweep.py ops/tests/test_fleet_executor_container.py -q --tb=line)
STEP_LABEL=io.cauce.gate.paso

die() { echo "release-gates: $*" >&2; exit 1; }

commands() {
  printf '%s\n' "${ORPHAN_SWEEP[*]}"
  printf 'pnpm %s\n' "${GATES[@]}"
}

is_sharded() {
  local gate
  for gate in "${SHARDED[@]}"; do [ "$gate" != "$1" ] || return 0; done
  return 1
}

# One lane per 3 CPUs and per 8 GiB available: most of a shard is serial PostgreSQL suites.
default_jobs() {
  local cpus mem_kib jobs
  cpus=$(nproc 2>/dev/null || echo 1)
  mem_kib=$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)
  jobs=$(( cpus / 3 ))
  (( ${mem_kib:-0} / 8388608 >= jobs )) || jobs=$(( ${mem_kib:-0} / 8388608 ))
  (( jobs >= 1 )) || jobs=1
  echo "$jobs"
}

asked_jobs() {
  local jobs="${CAUCE_RELEASE_GATES_JOBS:-$(default_jobs)}"
  [[ "$jobs" =~ ^[1-9][0-9]{0,3}$ ]] || die "CAUCE_RELEASE_GATES_JOBS debe ser un entero entre 1 y 9999 (es '$jobs')"
  echo "$jobs"
}

wanted_shards() {
  local shards="${CAUCE_RELEASE_GATES_SHARDS:-}"
  if [ -z "$shards" ]; then
    shards=4
    [ "$(asked_jobs)" != 1 ] || shards=1
  fi
  [[ "$shards" =~ ^[1-9][0-9]?$ ]] || die "CAUCE_RELEASE_GATES_SHARDS debe ser un entero entre 1 y 99 (es '$shards')"
  echo "$shards"
}

wanted_jobs() {
  local jobs units
  jobs="$(asked_jobs)"
  units=$(( ${#GATES[@]} - ${#SHARDED[@]} + ${#SHARDED[@]} * $(wanted_shards) ))
  (( jobs <= units )) || jobs=$units
  echo "$jobs"
}

[ "$(printf '%s\n' "${LAUNCH_ORDER[@]}" | sort)" = "$(printf '%s\n' "${GATES[@]}" | sort)" ] \
  || die "LAUNCH_ORDER no es una permutacion de GATES"

case "${1:-}" in
  --list) commands; exit 0 ;;
  --concurrencia) wanted_jobs; exit 0 ;;
  --trozos) wanted_shards; exit 0 ;;
  "") ;;
  *) echo "uso: scripts/release-gates.sh [--list | --concurrencia | --trozos]" >&2; exit 2 ;;
esac

(( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )) \
  || die "hace falta bash >= 5.1 (wait -n -p); es $BASH_VERSION"
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT_ROOT="${CAUCE_RELEASE_GATES_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cauce-v3/release-gates}"
[[ "$OUT_ROOT" = /* ]] || die "CAUCE_RELEASE_GATES_DIR debe ser una ruta absoluta"
LANES_ROOT="${CAUCE_RELEASE_GATES_LANES_DIR:-$(dirname "$REPO")/.cauce-release-gates-lanes}"
[[ "$LANES_ROOT" = /* ]] || die "CAUCE_RELEASE_GATES_LANES_DIR debe ser una ruta absoluta"
FAIL_FAST="${CAUCE_RELEASE_GATES_FAIL_FAST:-1}"
[[ "$FAIL_FAST" =~ ^[01]$ ]] || die "CAUCE_RELEASE_GATES_FAIL_FAST debe ser 0 o 1 (es '$FAIL_FAST')"
GRACE="${CAUCE_RELEASE_GATES_GRACE_SECONDS:-20}"
[[ "$GRACE" =~ ^[0-9]{1,3}$ ]] || die "CAUCE_RELEASE_GATES_GRACE_SECONDS debe ser un entero entre 0 y 999 (es '$GRACE')"
for tool in pnpm python3 shellcheck ruff git setsid realpath timeout; do
  command -v "$tool" >/dev/null || die "falta $tool en PATH (activa ~/.venvs/cauce-qa); no es un fallo de codigo"
done
# '..' and symlinks can land in gitignored paths inside the tree, which status will not show.
LANES_ROOT="$(realpath -m -- "$LANES_ROOT")" || die "no pude resolver CAUCE_RELEASE_GATES_LANES_DIR"
case "$LANES_ROOT/" in "$REPO"/*) die "los carriles no pueden vivir dentro del arbol que certifican: $LANES_ROOT" ;; esac
JOBS="$(wanted_jobs)"
SHARDS="$(wanted_shards)"
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
# The whole-stack suites queue per vitest process; with shards there are many processes, so they also share
# host-wide seats (tests/helpers/carril-exclusivo.setup.ts). Two seats: test and coverage, as the serial gate ran them.
export CAUCE_CARRIL_EXCLUSIVO_HOST="$OUT/carril-exclusivo" CAUCE_CARRIL_EXCLUSIVO_PLAZAS="${CAUCE_CARRIL_EXCLUSIVO_PLAZAS:-2}"
mkdir -m 700 "$CAUCE_CARRIL_EXCLUSIVO_HOST"
RUN_TOKEN="$(od -An -N8 -tx8 /dev/urandom | tr -d ' \n')"

LANE_DIRS=("$REPO")
FREE_LANES=()
LANES=""
LANES_ROOT_CREATED=""
UNITS_LAUNCHED=0
LAST_DISPLAY=""
declare -A NUMBER=() LOG_OF=() STARTED_AT=() RESULT=() RUN_DISPLAY=() RUN_LANE=() RUN_BEGAN=() RUN_TOKEN_OF=() SHARDS_GREEN=()
NUMBER["${ORPHAN_SWEEP[*]}"]=00
for index in "${!GATES[@]}"; do NUMBER["pnpm ${GATES[$index]}"]="$(printf '%02d' $((index + 1)))"; done
FAILED=""

# Every process a step starts inherits its token, also the ones that leave its process group.
token_pids() {
  grep -lzxF "CAUCE_RELEASE_GATES_PASO=$1" /proc/[0-9]*/environ 2>/dev/null | sed -E 's#^/proc/([0-9]+)/environ$#\1#' || true
}

signal_token() {
  local pids=()
  mapfile -t pids < <(token_pids "$2")
  [ "${#pids[@]}" = 0 ] || kill "-$1" "${pids[@]}" 2>/dev/null || true
}

any_token_alive() {
  local token
  for token in "$@"; do [ -z "$(token_pids "$token")" ] || return 0; done
  return 1
}

# A step that ended (or was ended) keeps nothing running: leftover processes and labelled containers go.
sweep_step() {
  local token="$1" display="$2" deadline ids=()
  if any_token_alive "$token"; then
    echo "release-gates: AVISO: $display dejo procesos vivos; los termino" >&2
    signal_token TERM "$token"
    deadline=$(( $(date +%s) + GRACE ))
    while any_token_alive "$token" && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.2; done
    signal_token KILL "$token"
  fi
  command -v docker >/dev/null 2>&1 || return 0
  mapfile -t ids < <(timeout 30 docker ps -aq --filter "label=$STEP_LABEL=$token" 2>/dev/null || true)
  [ "${#ids[@]}" -gt 0 ] && [ -n "${ids[0]}" ] || return 0
  echo "release-gates: retiro los contenedores de prueba de $display: ${ids[*]}" >&2
  timeout 60 docker rm -f "${ids[@]}" >/dev/null 2>&1 || echo "release-gates: AVISO: no pude retirar los contenedores de $display" >&2
}

finish() {
  local pid="$1" code="$2" interrupted="$3" display lane seconds log token
  display="${RUN_DISPLAY[$pid]}"
  lane="${RUN_LANE[$pid]}"
  token="${RUN_TOKEN_OF[$pid]}"
  seconds=$(( $(date +%s) - RUN_BEGAN[$pid] ))
  unset "RUN_DISPLAY[$pid]" "RUN_LANE[$pid]" "RUN_BEGAN[$pid]" "RUN_TOKEN_OF[$pid]"
  sweep_step "$token" "$display"
  FREE_LANES+=("$lane")
  log="${LOG_OF[$display]}"
  RESULT["$display"]="$code $(sha256sum "$OUT/$log" | cut -d' ' -f1) $seconds $log $lane ${STARTED_AT[$display]} $interrupted"
  LAST_DISPLAY="$display"
  if [ "$interrupted" = 1 ]; then
    echo "== $display: terminado (exit $code, ${seconds}s, carril $lane) -> $OUT/$log"
  else
    echo "== $display: exit $code (${seconds}s, carril $lane) -> $OUT/$log"
  fi
}

# TERM to each step's group and token, a grace period, then KILL; every step is reaped and recorded.
terminate_running() {
  local reason="$1" pid code deadline tokens=()
  [ "${#RUN_DISPLAY[@]}" -gt 0 ] || return 0
  echo "release-gates: $reason; termino ${#RUN_DISPLAY[@]} paso(s) en curso" >&2
  for pid in "${!RUN_DISPLAY[@]}"; do
    tokens+=("${RUN_TOKEN_OF[$pid]}")
    kill -TERM -- "-$pid" 2>/dev/null || true
    signal_token TERM "${RUN_TOKEN_OF[$pid]}"
  done
  deadline=$(( $(date +%s) + GRACE ))
  while any_token_alive "${tokens[@]}" && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.2; done
  for pid in "${!RUN_DISPLAY[@]}"; do
    kill -KILL -- "-$pid" 2>/dev/null || true
    signal_token KILL "${RUN_TOKEN_OF[$pid]}"
  done
  for pid in "${!RUN_DISPLAY[@]}"; do
    code=0
    wait "$pid" 2>/dev/null || code=$?
    finish "$pid" "$code" 1
  done
}

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
  trap - INT TERM HUP
  terminate_running "salida inesperada" || true
  remove_lanes
  exit "$code"
}

on_signal() {
  trap - INT TERM HUP
  echo "release-gates: interrumpido; no emito recibo (logs en $OUT)" >&2
  terminate_running "interrumpido"
  exit 130
}
trap on_exit EXIT
trap on_signal INT TERM HUP

# Worktrees one after another (git locks its metadata), installs all at once.
prepare_lanes() {
  local wanted="$1" index dir log k pids=() indexes=()
  [ -d "$LANES_ROOT" ] || LANES_ROOT_CREATED=1
  if ! mkdir -p "$LANES_ROOT" || ! LANES="$(mktemp -d "$LANES_ROOT/${COMMIT:0:12}-XXXXXX")"; then
    LANES=""
    echo "release-gates: AVISO: no pude crear carriles en $LANES_ROOT; sigo con ${#LANE_DIRS[@]} carril(es)" >&2
    return 0
  fi
  for (( index = 1; index < wanted; index++ )); do
    dir="$LANES/carril-$index"
    log="$OUT/carril-$index.log"
    echo "== carril $index: worktree desechable de $COMMIT en $dir"
    if git worktree add --detach "$dir" "$COMMIT" >"$log" 2>&1 </dev/null; then
      (cd "$dir" && pnpm install --frozen-lockfile --prefer-offline) >>"$log" 2>&1 </dev/null &
      pids+=("$!")
      indexes+=("$index")
    else
      git worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"
      echo "release-gates: AVISO: el carril $index no quedo listo (log en $log)" >&2
    fi
  done
  for k in "${!pids[@]}"; do
    index="${indexes[$k]}"
    dir="$LANES/carril-$index"
    if wait "${pids[$k]}" \
      && [ "$(git -C "$dir" rev-parse HEAD)" = "$COMMIT" ] \
      && [ -z "$(git -C "$dir" status --porcelain)" ]; then
      LANE_DIRS[index]="$dir"
      FREE_LANES+=("$index")
      continue
    fi
    git worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"
    echo "release-gates: AVISO: el carril $index no quedo listo (log en $OUT/carril-$index.log)" >&2
  done
  [ "${#LANE_DIRS[@]}" -ge "$wanted" ] || echo "release-gates: AVISO: sigo con ${#LANE_DIRS[@]} carril(es)" >&2
}

launch() {
  local display="$1" slug="$2" lane="$3" pid log token
  shift 3
  log="${NUMBER[${display%% \[*}]}-$slug.log"
  UNITS_LAUNCHED=$(( UNITS_LAUNCHED + 1 ))
  token="$RUN_TOKEN-$UNITS_LAUNCHED"
  LOG_OF["$display"]="$log"
  STARTED_AT["$display"]="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  (cd "${LANE_DIRS[$lane]}" && CAUCE_RELEASE_GATES_PASO="$token" exec setsid -w "$@") >"$OUT/$log" 2>&1 </dev/null &
  pid=$!
  RUN_DISPLAY[$pid]="$display"
  RUN_LANE[$pid]="$lane"
  RUN_BEGAN[$pid]="$(date +%s)"
  RUN_TOKEN_OF[$pid]="$token"
  echo "== $display: arranca en el carril $lane"
}

# A queue entry is a gate, a gate#i shard or a gate#fusion step.
launch_unit() {
  local entry="$1" lane="$2" gate part slug dir
  gate="${entry%%#*}"
  part="${entry#"$gate"}"
  part="${part#\#}"
  slug="${gate//:/-}"
  dir="$OUT/trozos-$slug"
  case "$part" in
    "") launch "pnpm $gate" "$slug" "$lane" pnpm "$gate" ;;
    fusion) launch "pnpm $gate [fusion]" "$slug" "$lane" \
      env "CAUCE_TEST_SHARD_MERGE=$SHARDS" "CAUCE_TEST_SHARD_DIR=$dir" pnpm "$gate" ;;
    *) launch "pnpm $gate [$part/$SHARDS]" "$slug-trozo-$part" "$lane" \
      env "CAUCE_TEST_SHARD=$part/$SHARDS" "CAUCE_TEST_SHARD_DIR=$dir" pnpm "$gate" ;;
  esac
}

reap() {
  local pid="" code=0 display gate
  wait -n -p pid || code=$?
  [ -n "$pid" ] || die "wait no devolvio ningun paso con ${#RUN_DISPLAY[@]} en curso"
  finish "$pid" "$code" 0
  display="$LAST_DISPLAY"
  if [ "$code" = 0 ]; then
    [[ "$display" =~ ^pnpm\ (.+)\ \[[0-9]+/[0-9]+\]$ ]] || return 0
    gate="${BASH_REMATCH[1]}"
    SHARDS_GREEN["$gate"]=$(( ${SHARDS_GREEN[$gate]:-0} + 1 ))
    [ -n "$FAILED" ] || [ "${SHARDS_GREEN[$gate]}" != "$SHARDS" ] || PENDING=("$gate#fusion" "${PENDING[@]}")
    return 0
  fi
  tail -n 40 "$OUT/${LOG_OF[$display]}" >&2
  [ -n "$FAILED" ] || FAILED="$display"
  [ "${#RUN_DISPLAY[@]}" != 0 ] || return 0
  if [ "$FAIL_FAST" = 1 ]; then
    terminate_running "ROJO en $display; fallo rapido"
  else
    echo "release-gates: ROJO en $display; no arranco mas pasos y espero a los ${#RUN_DISPLAY[@]} en curso (Ctrl-C los termina sin recibo)" >&2
  fi
}

if [ "$JOBS" = 1 ]; then
  echo "release-gates: $COMMIT en secuencia en este checkout (CAUCE_RELEASE_GATES_JOBS=1, $SHARDS trozo(s))"
else
  echo "release-gates: $COMMIT con hasta $JOBS carriles y $SHARDS trozo(s) para ${SHARDED[*]}; los extra son worktrees desechables en $LANES_ROOT"
fi
launch "${ORPHAN_SWEEP[*]}" orphan-sweep 0 "${ORPHAN_SWEEP[@]}"
reap
PENDING=()
if [ -z "$FAILED" ]; then
  for gate in "${ORDER[@]}"; do
    if [ "$SHARDS" -gt 1 ] && is_sharded "$gate"; then
      for (( shard = 1; shard <= SHARDS; shard++ )); do PENDING+=("$gate#$shard"); done
    else
      PENDING+=("$gate")
    fi
  done
  [ "$JOBS" = 1 ] || prepare_lanes "$JOBS"
fi
while :; do
  while [ -z "$FAILED" ] && [ "${#PENDING[@]}" -gt 0 ] && [ "${#FREE_LANES[@]}" -gt 0 ]; do
    lane="${FREE_LANES[0]}"
    FREE_LANES=("${FREE_LANES[@]:1}")
    entry="${PENDING[0]}"
    PENDING=("${PENDING[@]:1}")
    launch_unit "$entry" "$lane"
  done
  [ "${#RUN_DISPLAY[@]}" -gt 0 ] || break
  reap
done
FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

[ "$(git rev-parse HEAD)" = "$COMMIT" ] || die "HEAD cambio durante el gate; recibo no emitido (logs en $OUT)"
DIRTY_NOTES=()
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  [ -n "$FAILED" ] || die "los gates modificaron el arbol; recibo no emitido (logs en $OUT):"$'\n'"$DIRTY"
  DIRTY_NOTES+=("carril 0: $DIRTY")
fi
for lane in "${!LANE_DIRS[@]}"; do
  [ "$lane" != 0 ] || continue
  [ "$(git -C "${LANE_DIRS[$lane]}" rev-parse HEAD)" = "$COMMIT" ] \
    || die "HEAD cambio en el carril $lane durante el gate; recibo no emitido (logs en $OUT)"
  DIRTY="$(git -C "${LANE_DIRS[$lane]}" status --porcelain)"
  [ -n "$DIRTY" ] || continue
  [ -n "$FAILED" ] || die "los gates modificaron el carril $lane; recibo no emitido (logs en $OUT):"$'\n'"$DIRTY"
  DIRTY_NOTES+=("carril $lane: $DIRTY")
done

SUFFIXES=("")
for (( shard = 1; shard <= SHARDS; shard++ )); do SUFFIXES+=(" [$shard/$SHARDS]"); done
SUFFIXES+=(" [fusion]")
ROWS=()
while IFS= read -r display; do
  for suffix in "${SUFFIXES[@]}"; do
    unit="$display$suffix"
    [ -n "${RESULT[$unit]:-}" ] || continue
    read -r code digest seconds log lane began interrupted <<<"${RESULT[$unit]}"
    ROWS+=("$unit" "$code" "$digest" "$seconds" "$log" "$lane" "$began" "$interrupted")
  done
done < <(commands)

python3 - "$OUT/recibo.json" "$COMMIT" "$TREE" "$STARTED" "$FINISHED" "$JOBS" "${#LANE_DIRS[@]}" "$SHARDS" "$FAIL_FAST" \
  "$(commands)" "$(printf '%s\n' "${DIRTY_NOTES[@]}")" "${ROWS[@]}" <<'PY'
import calendar
import json
import os
import re
import sys
import time

path, commit, tree, started, finished, jobs, lanes, shards, fail_fast, listed, dirty, *rows = sys.argv[1:]
ROW = re.compile(r"^\s+(\S+)\s+(\S+)\s+base (\d+(?:\.\d+)?)%\s+medido (\d+(?:\.\d+)?)%")
MERGED = re.compile(r"CIFRA FUSIONADA\s+lineas \d+/\d+ = (\d+(?:\.\d+)?)%")
SHARD = re.compile(r"^(.*) \[(\d+)/\d+\]$")
FUSION = re.compile(r"^(.*) \[fusion\]$")


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


def row(cmd, code, digest, seconds, log, lane, began, interrupted):
    entry = {"cmd": cmd, "exit": int(code), "log_sha256": digest, "duracion": int(seconds), "log": log,
             "carril": int(lane), "inicio": began}
    if interrupted == "1":
        entry["interrumpido"] = True
    return entry


def epoch(stamp):
    return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))


units = [row(*fields) for fields in zip(*[iter(rows)] * 8)]
plain, parts, fusions = {}, {}, {}
for unit in units:
    shard, fusion = SHARD.match(unit["cmd"]), FUSION.match(unit["cmd"])
    if shard:
        parts.setdefault(shard[1], []).append({**unit, "trozo": f"{shard[2]}/{shards}"})
    elif fusion:
        fusions[fusion[1]] = unit
    else:
        plain[unit["cmd"]] = unit


def logical(cmd):
    pieces = sorted(parts.get(cmd, []), key=lambda unit: int(unit["trozo"].split("/")[0]))
    fused = fusions.get(cmd)
    reds = sorted((unit for unit in pieces if unit["exit"] != 0), key=lambda unit: bool(unit.get("interrumpido")))
    red = reds[0] if reds else None
    base = fused or red or pieces[0]
    every = pieces + ([fused] if fused else [])
    first = min(epoch(unit["inicio"]) for unit in every)
    entry = {"cmd": cmd, "exit": fused["exit"] if fused else (red["exit"] if red else 1),
             "log_sha256": base["log_sha256"], "log": base["log"], "carril": base["carril"],
             "inicio": min(every, key=lambda unit: epoch(unit["inicio"]))["inicio"],
             "duracion": max(epoch(unit["inicio"]) + unit["duracion"] for unit in every) - first,
             "trozos": [{key: value for key, value in unit.items() if key != "cmd"} for unit in pieces],
             "fusion": {key: value for key, value in fused.items() if key != "cmd"} if fused else None}
    if not fused:
        entry["sin_fusion"] = True
    if any(unit.get("interrumpido") for unit in every):
        entry["interrumpido"] = True
    return entry


commands = []
for cmd in listed.splitlines():
    if cmd in plain:
        commands.append(plain[cmd])
    elif cmd in parts or cmd in fusions:
        commands.append(logical(cmd))
ratchet = next((command for command in commands if command["cmd"] == "pnpm coverage:ratchet"), None)
receipt = {
    "commit": commit, "tree": tree, "comandos": commands, "inicio": started, "fin": finished,
    "concurrencia": int(jobs), "carriles": int(lanes), "trozos": int(shards), "fallo_rapido": fail_fast == "1",
    "cobertura": coverage(ratchet["log"]) if ratchet else None,
}
if dirty.strip():
    receipt["carriles_sucios"] = dirty.strip().splitlines()
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
