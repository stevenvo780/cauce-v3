#!/usr/bin/env bash
# The installer must publish every sibling binary `cauce` execs, and the syntax check dispatches
# on the shebang because `bash -n` on a python file is a false verdict, not a check.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RAIZ=$(cd "$HERE/.." && pwd)
INSTALADOR="$RAIZ/scripts/install-cauce-cli.sh"

fail=0
ok() { printf 'ok: %s\n' "$1"; }
bad() { printf 'FAIL: %s\n' "$1" >&2; fail=1; }

WORK=$(mktemp -d)
# shellcheck disable=SC2329,SC2317  # invoked indirectly, via the EXIT trap below
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ESPERADOS=(cauce host_enrollment.py host_channel_client.py cauce-credenciales.lib.sh cauce-panel cauce-huerfanas cauce-reponer cauce-estado cauce-sesiones cauce-attach)

# py_compile writes `<dir>/__pycache__/<name>.pyc` a level deeper, so the probe reaches depth 2.
MARCA="$WORK/marca"
touch "$MARCA"
bytecode_nuevo() {  # $1=directory whose sources are compiled
  find "$1" -maxdepth 2 -name '*.pyc' -newer "$MARCA" -print -quit
}

# --- 1) `bash -n` is the wrong check for half the payload -------------------------------------
if bash -n "$RAIZ/guardias/cauce-estado" 2>/dev/null; then
  bad "premise: bash -n should NOT accept a python3 source"
else
  ok "premise: bash -n rejects cauce-estado, so the check must dispatch on the shebang"
fi

# --- 2) a clean install publishes every binary `cauce` execs ----------------------------------
DEST="$WORK/bin"
HOGAR="$WORK/hogar"
mkdir -p "$HOGAR"
salida=$(HOME="$HOGAR" "$INSTALADOR" "$DEST" 2>&1); rc=$?
if [ "$rc" = 0 ]; then ok "install exits 0"; else bad "install exits 0 (rc=$rc): $salida"; fi
for n in "${ESPERADOS[@]}"; do
  if [ -x "$DEST/$n" ]; then ok "publica $n"; else bad "publica $n"; fi
done
if "$DEST/cauce" hosts enroll --help 2>&1 | grep -q -- '--invitation-stdin'; then
  ok "enrolamiento disponible desde el CLI instalado"
else
  bad "enrolamiento disponible desde el CLI instalado"
fi
n_instalados=$(find "$DEST" -maxdepth 1 -type f | wc -l)
if [ "$n_instalados" = "${#ESPERADOS[@]}" ]; then
  ok "publica exactamente ${#ESPERADOS[@]} ficheros"
else
  bad "publica exactamente ${#ESPERADOS[@]} ficheros (encontrados $n_instalados)"
fi

ln -s "$DEST/cauce" "$WORK/cauce-enlace"
for invocado in "$DEST/cauce" "$WORK/cauce-enlace"; do  # 2b) loads its lib, also through a symlink
  salida=$(HOME="$HOGAR" timeout 20 bash "$invocado" --help 2>&1)
  if printf '%s' "$salida" | grep -q 'cauce-credenciales.lib.sh'; then
    bad "el CLI instalado carga su lib ($invocado): $(printf '%s' "$salida" | head -1)"
  else
    ok "el CLI instalado carga su lib ($invocado)"
  fi
done
rm -f "$WORK/cauce-enlace"
SIN_LIB="$WORK/sin-lib"; CON_LIB="$WORK/con-lib"; mkdir -p "$SIN_LIB" "$CON_LIB"  # 2c) sin lib se niegan
cp "$RAIZ/cli/cauce-credenciales.lib.sh" "$CON_LIB/"
for dir_cli in "$SIN_LIB" "$CON_LIB"; do
  sed '/^case /,$d' "$DEST/cauce" > "$dir_cli/cauce"
  bash -c "source '$dir_cli/cauce' 2>/dev/null; lib_credenciales_ok" >/dev/null 2>&1
  echo "$dir_cli=$?" >> "$WORK/resultado"
done
if grep -qx "$SIN_LIB=1" "$WORK/resultado" && grep -qx "$CON_LIB=0" "$WORK/resultado"; then ok "sin la lib, retirar/login/aprovisionar se niegan"; else bad "sin la lib, retirar/login/aprovisionar se niegan ($(tr '\n' ' ' < "$WORK/resultado"))"; fi

# --- 3) it writes NOWHERE else: not in $HOME, not as bytecode inside the repo -----------------
if [ -z "$(find "$HOGAR" -mindepth 1 -print -quit)" ]; then
  ok "no escribe en \$HOME cuando se le da un destino"
else
  bad "no escribe en \$HOME cuando se le da un destino"
fi
CONTROL="$WORK/control/guardias/__pycache__"
mkdir -p "$CONTROL"
touch "$CONTROL/testigo.cpython-312.pyc"
if [ -n "$(bytecode_nuevo "$WORK/control/guardias")" ]; then
  ok "la sonda de bytecode ve un .pyc en __pycache__ (si no, no probaria nada)"
else
  bad "la sonda de bytecode ve un .pyc en __pycache__ (si no, no probaria nada)"
fi
if [ -z "$(bytecode_nuevo "$RAIZ/guardias")" ]; then
  ok "py_compile no deja bytecode dentro del repo"
else
  bad "py_compile no deja bytecode dentro del repo"
fi

# --- 4) the installed copy is the repo source, byte for byte ----------------------------------
if cmp -s "$RAIZ/guardias/cauce-sesiones" "$DEST/cauce-sesiones"; then
  ok "cauce-sesiones instalado es identico a la fuente versionada"
else
  bad "cauce-sesiones instalado es identico a la fuente versionada"
fi

# --- 5) reinstalling over a modified target keeps the previous version ------------------------
printf '\n# tocado a mano\n' >> "$DEST/cauce-panel"
HOME="$HOGAR" "$INSTALADOR" "$DEST" >/dev/null 2>&1
copias=$(find "$DEST" -maxdepth 1 -name 'cauce-panel.bak-*' | wc -l)
if [ "$copias" = 1 ]; then ok "guarda copia del anterior antes de pisarlo"; else bad "guarda copia del anterior antes de pisarlo (copias=$copias)"; fi
if cmp -s "$RAIZ/cli/cauce-panel" "$DEST/cauce-panel"; then
  ok "tras reinstalar, el destino vuelve a ser la fuente"
else
  bad "tras reinstalar, el destino vuelve a ser la fuente"
fi

# --- 6) a source whose interpreter is unknown is refused, and nothing is installed -------------
mkdir -p "$WORK/ops/cli" "$WORK/ops/scripts"
printf 'ni shebang ni nada\n' > "$WORK/ops/cli/cauce"
install -m 0755 "$INSTALADOR" "$WORK/ops/scripts/install-cauce-cli.sh"
err=$(HOME="$HOGAR" "$WORK/ops/scripts/install-cauce-cli.sh" "$WORK/bin2" 2>&1); rc=$?
if [ "$rc" != 0 ]; then ok "rechaza una fuente sin interprete reconocible"; else bad "rechaza una fuente sin interprete reconocible"; fi
case "$err" in
  *interprete*) ok "y dice por que la rechaza" ;;
  *) bad "y dice por que la rechaza (salida: $err)" ;;
esac
if [ ! -e "$WORK/bin2/cauce" ]; then ok "no instala nada de la fuente rechazada"; else bad "no instala nada de la fuente rechazada"; fi

HOGAR2="$WORK/hogar2"; mkdir -p "$HOGAR2"; AVISO="$HOGAR2/.config/cauce-v3/attach-aviso.json"
HOME="$HOGAR2" CAUCE_DESTINO_AVISO_INICIAL=steven_dm "$INSTALADOR" "$WORK/bin3" >/dev/null 2>&1
if [ "$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["destino"])' "$AVISO" 2>/dev/null)" = steven_dm ] \
   && [ "$(stat -c '%a' "$AVISO")" = 600 ]; then
  ok "con CAUCE_DESTINO_AVISO_INICIAL siembra attach-aviso.json privado"
else
  bad "con CAUCE_DESTINO_AVISO_INICIAL siembra attach-aviso.json privado"
fi
HOME="$HOGAR2" CAUCE_DESTINO_AVISO_INICIAL=otro_destino "$INSTALADOR" "$WORK/bin3" >/dev/null 2>&1
if grep -q steven_dm "$AVISO"; then ok "no pisa un attach-aviso.json existente"; else bad "no pisa un attach-aviso.json existente"; fi
if HOME="$HOGAR" "$INSTALADOR" "$DEST" 2>&1 | grep -q 'aviso de attach sin destino'; then
  ok "sin destino lo dice en vez de inventar uno"
else
  bad "sin destino lo dice en vez de inventar uno"
fi

[ "$fail" = 0 ] && echo "ALL OK"
exit "$fail"
