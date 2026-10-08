#!/usr/bin/env bash
# Extract the CLI implementation to signal real owned processes in /proc.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI="$HERE/../cli/cauce"

fail=0
ok() { printf 'ok: %s\n' "$1"; }
bad() { printf 'FAIL: %s\n' "$1" >&2; fail=1; }
vivo() { [ -d "/proc/$1" ] && ! grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null; }

extraer() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{"{p=1} p{print; if (/^}$/) exit}' "$CLI"; }
barrido=$(grep -m1 "^BARRIDO=" "$CLI")
[ -n "$barrido" ] || { echo "FAIL: BARRIDO no esta en $CLI" >&2; exit 1; }
eval "$barrido"
for f in pids_del_alias senalar_alias esperar_sin_pids apagar_restos; do
  src=$(extraer "$f"); [ -n "$src" ] || { echo "FAIL: $f() no esta en $CLI" >&2; exit 1; }
  eval "$src"
done
# shellcheck disable=SC2329,SC2317
es_host_native() { return 0; }
# shellcheck disable=SC2034
c_warn='' c_reset=''

WORK=$(mktemp -d)
PIDS=()
# shellcheck disable=SC2329,SC2317  # via trap
cleanup() { for p in "${PIDS[@]}"; do kill -KILL "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

A1="zzoff$$"
env -u CAUCE_ALIAS python3 -c 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)' \
  "$WORK/cauce-v3-adapter/$A1/fake" & p1=$!; PIDS+=("$p1")
sleep 0.5
if [ -n "$(pids_del_alias "$A1")" ]; then
  ok "el barrido reconoce el hijo por su cmdline"
else
  bad "el barrido no ve el proceso de prueba"
fi

e=$(tr '\0' '\n' < "/proc/$p1/environ" 2>/dev/null | sed -n 's/^CAUCE_ALIAS=//p' | head -1)
if [ "$e" = "$A1" ]; then
  bad "precondicion: el proceso no deberia llevar CAUCE_ALIAS"
else
  ok "defecto reproducido: la reconfirmacion por environ lo descartaria y nunca lo senalaria"
fi

CAUCE_OFF_GRACIA=2 apagar_restos "$A1" >/dev/null
sleep 0.3
if vivo "$p1"; then
  bad "apagar_restos dejo vivo un proceso que ignora SIGTERM"
else
  ok "apagar_restos escala a SIGKILL y lo apaga"
fi

A2="zzdrena$$"
CAUCE_ALIAS=$A2 python3 -c 'import signal,time,sys
def h(*_): time.sleep(4); sys.exit(0)
signal.signal(signal.SIGTERM, h); time.sleep(120)' & p2=$!; PIDS+=("$p2")
sleep 0.5
if [ -n "$(pids_del_alias "$A2")" ]; then
  ok "el barrido reconoce el adaptador por CAUCE_ALIAS"
else
  bad "el barrido no ve el adaptador de prueba"
fi
t0=$SECONDS
CAUCE_OFF_GRACIA=10 apagar_restos "$A2" >/dev/null; rc=$?
if vivo "$p2"; then
  bad "el adaptador que drena sigue vivo"
else
  ok "espera la CONDICION: el adaptador que drena termina (rc=$rc, $((SECONDS - t0)) s)"
fi
if [ $((SECONDS - t0)) -ge 3 ]; then
  ok "no le mando SIGKILL antes de tiempo (espero al drenaje)"
else
  bad "corto antes de que drenara"
fi

A3="zzmcp$$"
for bin in cauce-mcp.js cauce-decisiones-mcp.js; do
  env -u CAUCE_ALIAS python3 -c 'import time; time.sleep(120)' \
    "$WORK/cauce-v3-adapter/$A3/releases/x/packages/adapter-sdk/dist/src/bin/$bin" "$WORK/mcp.sock" & PIDS+=("$!")
done
sleep 0.5
if [ -z "$(pids_del_alias "$A3")" ]; then
  ok "los puentes MCP sin CAUCE_ALIAS (cauce-mcp y cauce-decisiones-mcp) no cuentan como adaptador"
else
  bad "el barrido cuenta puentes MCP del gateway como adaptador: $(pids_del_alias "$A3" | tr '\n' ' ')"
fi

A4="zzphysical$$"
CAUCE_ALIAS=shared_alias CAUCE_RUNTIME_KEY=$A4 python3 -c 'import time; time.sleep(120)' & p4=$!; PIDS+=("$p4")
CAUCE_ALIAS=$A4 CAUCE_RUNTIME_KEY="other-$A4" python3 -c 'import time; time.sleep(120)' & p5=$!; PIDS+=("$p5")
sleep 0.5
found=$(pids_del_alias "$A4")
if [ "$found" = "$p4" ]; then
  ok "el barrido prioriza runtime key y conserva el proceso de otro runtime con wire alias coincidente"
else
  bad "el barrido confundio wire alias y runtime key: $found"
fi

exit $fail
