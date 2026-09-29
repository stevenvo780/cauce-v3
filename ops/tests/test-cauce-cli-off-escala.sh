#!/usr/bin/env bash
# `cauce <alias> off` (y por lo tanto `login`) tiene que APAGAR lo que sobrevive a systemd.
# Medido 2026-09-29: `cauce argos login codex` desde la portatil abortó con «argos SIGUE VIVO … no
# lo pude apagar: no sigo». Dos defectos: (1) la reconfirmacion antes de senalar miraba solo
# CAUCE_ALIAS en environ, asi que un proceso que el barrido reconoce por su cmdline nunca recibia
# la senal; (2) tras SIGTERM esperaba un `sleep 2` fijo y sin SIGKILL, y un adaptador que drena
# tarda mas. Extrae las funciones REALES de ops/cli/cauce (no una copia) y las corre contra
# procesos de verdad en /proc.
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
es_host_native() { return 0; }   # camino host-native: el barrido mira el /proc local
c_warn=''; c_reset=''

WORK=$(mktemp -d)
PIDS=()
# shellcheck disable=SC2329,SC2317  # via trap
cleanup() { for p in "${PIDS[@]}"; do kill -KILL "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

# --- 1) hijo reconocido por cmdline, SIN CAUCE_ALIAS, que ignora SIGTERM ----------------------
A1="zzoff$$"
env -u CAUCE_ALIAS python3 -c 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)' \
  "$WORK/cauce-v3-adapter/$A1/fake" & p1=$!; PIDS+=("$p1")
sleep 0.5
[ -n "$(pids_del_alias "$A1")" ] && ok "el barrido reconoce el hijo por su cmdline" || bad "el barrido no ve el proceso de prueba"

# El defecto tal como se desplego: reconfirmar por environ -> no se senala nada.
e=$(tr '\0' '\n' < "/proc/$p1/environ" 2>/dev/null | sed -n 's/^CAUCE_ALIAS=//p' | head -1)
[ "$e" = "$A1" ] && bad "precondicion: el proceso no deberia llevar CAUCE_ALIAS" \
  || ok "defecto reproducido: la reconfirmacion por environ lo descartaria y nunca lo senalaria"

CAUCE_OFF_GRACIA=2 apagar_restos "$A1" >/dev/null
sleep 0.3
vivo "$p1" && bad "apagar_restos dejo vivo un proceso que ignora SIGTERM" || ok "apagar_restos escala a SIGKILL y lo apaga"

# --- 2) adaptador que DRENA: sale solo 4 s despues del SIGTERM ---------------------------------
A2="zzdrena$$"
CAUCE_ALIAS=$A2 python3 -c 'import signal,time,sys
def h(*_): time.sleep(4); sys.exit(0)
signal.signal(signal.SIGTERM, h); time.sleep(120)' & p2=$!; PIDS+=("$p2")
sleep 0.5
[ -n "$(pids_del_alias "$A2")" ] && ok "el barrido reconoce el adaptador por CAUCE_ALIAS" || bad "el barrido no ve el adaptador de prueba"
t0=$SECONDS
CAUCE_OFF_GRACIA=10 apagar_restos "$A2" >/dev/null; rc=$?
vivo "$p2" && bad "el adaptador que drena sigue vivo" || ok "espera la CONDICION: el adaptador que drena termina (rc=$rc, $((SECONDS - t0)) s)"
[ $((SECONDS - t0)) -ge 3 ] && ok "no le mando SIGKILL antes de tiempo (espero al drenaje)" || bad "corto antes de que drenara"

# --- 3) los puentes MCP del gateway/panel NO son del adaptador ---------------------------------
# Lo que de verdad tumbo el login de argos: cauce-decisiones-mcp.js (hijo del gateway OpenClaw, sin
# CAUCE_ALIAS) cuadraba con el patron del bundle y el barrido lo contaba como adaptador vivo.
A3="zzmcp$$"
for bin in cauce-mcp.js cauce-decisiones-mcp.js; do
  env -u CAUCE_ALIAS python3 -c 'import time; time.sleep(120)' \
    "$WORK/cauce-v3-adapter/$A3/releases/x/packages/adapter-sdk/dist/src/bin/$bin" "$WORK/mcp.sock" & PIDS+=("$!")
done
sleep 0.5
[ -z "$(pids_del_alias "$A3")" ] && ok "los puentes MCP sin CAUCE_ALIAS (cauce-mcp y cauce-decisiones-mcp) no cuentan como adaptador" \
  || bad "el barrido cuenta puentes MCP del gateway como adaptador: $(pids_del_alias "$A3" | tr '\n' ' ')"

exit $fail
