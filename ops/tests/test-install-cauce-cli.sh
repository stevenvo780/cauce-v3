#!/usr/bin/env bash
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

ESPERADOS=(cauce cauce-platform cauce-diagnose cauce-login cauce-spaces host_enrollment.py host_channel_client.py host_setup.py host_image.py context_client.py context_native.py space_archive.py cauce-credenciales.lib.sh cauce-panel cauce-huerfanas cauce-reponer cauce-estado cauce-sesiones cauce-attach)

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
mkdir -p "$HOGAR/.config/cauce-v3"
printf '%s\n' '{"destino":"steven_dm"}' > "$HOGAR/.config/cauce-v3/attach-aviso.json"
chmod 600 "$HOGAR/.config/cauce-v3/attach-aviso.json"
salida=$(HOME="$HOGAR" "$INSTALADOR" "$DEST" 2>&1); rc=$?
if [ "$rc" = 0 ]; then ok "install exits 0"; else bad "install exits 0 (rc=$rc): $salida"; fi
for n in "${ESPERADOS[@]}"; do
  if [ -x "$DEST/$n" ]; then ok "publica $n"; else bad "publica $n"; fi
done
if cmp -s "$RAIZ/cli/cauce-diagnose" "$DEST/cauce-diagnose" && [ "$(stat -c '%a' "$DEST/cauce-diagnose" 2>/dev/null)" = 755 ]; then
  ok "installed diagnose preserves source bytes and mode 0755"
else
  bad "installed diagnose preserves source bytes and mode 0755"
fi
if "$DEST/cauce-diagnose" --help > "$WORK/diagnose-help" 2>&1 && grep -q -- '--session-file' "$WORK/diagnose-help"; then
  ok "installed diagnose loads context authentication and exposes its session option"
else
  bad "installed diagnose loads context authentication and exposes its session option"
fi
if python3 -B - "$DEST/cauce-diagnose" "$WORK" <<'PY'
import json
import pathlib
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

observed = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        observed.append((self.path, self.headers.get('Cookie'), self.headers.get('Origin')))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"company_id":"fixture","items":[],"truncated":false}')


session = pathlib.Path(sys.argv[2]) / 'diagnose-session.json'
server = HTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = 'http://127.0.0.1:' + str(server.server_port)
session.write_text(json.dumps({'cookie': 'cauce_session=synthetic-install-session', 'gateway': origin, 'origin': origin}))
session.chmod(0o600)
try:
    result = subprocess.run([sys.argv[1], 'trace/install', '--gateway', origin, '--origin', origin,
                             '--session-file', str(session)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0 and result.stderr == ''
    assert json.loads(result.stdout) == {'company_id': 'fixture', 'items': [], 'truncated': False}
    assert observed == [('/v3/console/diagnose/trace%2Finstall', 'cauce_session=synthetic-install-session', origin)]
finally:
    server.shutdown()
    server.server_close()
    thread.join()
PY
then
  ok "installed diagnose authenticates against a real local HTTP server"
else
  bad "installed diagnose authenticates against a real local HTTP server"
fi
# Installed copy, empty home: setup/status must reach host_setup and fail with a message, never a traceback.
estado=$(HOME="$HOGAR" "$DEST/cauce" hosts status 2>&1); rc=$?
if [ "$rc" = 1 ] && grep -q 'expected exactly one enrolled identity' <<< "$estado" && ! grep -q Traceback <<< "$estado"; then
  ok "hosts status corre desde el CLI instalado sin trazas"
else
  bad "hosts status corre desde el CLI instalado sin trazas (rc=$rc): $estado"
fi
if "$DEST/cauce" hosts enroll --help 2>&1 | grep -q -- '--invitation-stdin'; then
  ok "enrolamiento disponible desde el CLI instalado"
else
  bad "enrolamiento disponible desde el CLI instalado"
fi
n_instalados=$(find "$DEST" -maxdepth 1 -type f | wc -l)
for context_command in login context context-native spaces; do
  if PYTHONDONTWRITEBYTECODE=1 "$DEST/cauce" "$context_command" --help >/dev/null 2>&1; then
    ok "$context_command disponible desde el CLI instalado"
  else
    bad "$context_command disponible desde el CLI instalado"
  fi
done
DIAG_HOME="$WORK/diagnose-home"; SHIMS="$WORK/shims"
mkdir -p "$DIAG_HOME/.local" "$SHIMS"
ln -s "$DEST" "$DIAG_HOME/.local/bin"
cat > "$SHIMS/getent" <<'EOF'
#!/bin/sh
printf 'fixture:x:1000:1000::%s:/bin/sh\n' "$CAUCE_TEST_CLI_HOME"
EOF
chmod +x "$SHIMS/getent"
if HOME="$DIAG_HOME" CAUCE_TEST_CLI_HOME="$DIAG_HOME" CAUCE_FLEET_RUNTIME_STATE='' PATH="$SHIMS:$PATH" "$DEST/cauce" diagnose --help 2>&1 | grep -q 'cauce diagnose'; then
  ok "diagnose tiene precedencia sobre aliases y flota dinámica desde el CLI instalado"
else
  bad "diagnose tiene precedencia sobre aliases y flota dinámica desde el CLI instalado"
fi
rm "$DIAG_HOME/.local/bin"
missing=$(HOME="$DIAG_HOME" CAUCE_TEST_CLI_HOME="$DIAG_HOME" CAUCE_FLEET_RUNTIME_STATE='' PATH="$SHIMS:$PATH" "$DEST/cauce" diagnose --help 2>&1); rc=$?
if [ "$rc" = 3 ] && grep -q 'falta cauce-diagnose' <<< "$missing"; then
  ok "diagnose sin helper da un error accionable antes de resolver aliases"
else
  bad "diagnose sin helper da un error accionable (rc=$rc): $missing"
fi
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

# No writes to $HOME or repo bytecode; attach-aviso.json is fixture input, not installer output.
if [ -z "$(find "$HOGAR" -mindepth 1 \
  ! -path "$HOGAR/.config" \
  ! -path "$HOGAR/.config/cauce-v3" \
  ! -path "$HOGAR/.config/cauce-v3/attach-aviso.json" \
  -print -quit)" ]; then
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
HOGAR_SIN="$WORK/hogar-sin"
mkdir -p "$HOGAR_SIN"
err=$(HOME="$HOGAR_SIN" CAUCE_DESTINO_AVISO_INICIAL='' "$INSTALADOR" "$WORK/bin-sin" 2>&1); rc=$?
if [ "$rc" != 0 ] && grep -q 'aviso de attach sin destino' <<< "$err"; then
  ok "sin destino falla en vez de inventar uno"
else
  bad "sin destino falla en vez de inventar uno (rc=$rc): $err"
fi
if [ ! -e "$WORK/bin-sin" ]; then
  ok "sin destino rechaza antes de crear el directorio de binarios"
else
  bad "sin destino rechaza antes de crear el directorio de binarios"
fi
mkdir -p "$WORK/bin-previo"
printf 'existing binary\n' > "$WORK/bin-previo/cauce"
err=$(HOME="$HOGAR_SIN" CAUCE_DESTINO_AVISO_INICIAL='' "$INSTALADOR" "$WORK/bin-previo" 2>&1); rc=$?
if [ "$rc" = 1 ] && [ "$(cat "$WORK/bin-previo/cauce")" = 'existing binary' ] \
  && [ "$(find "$WORK/bin-previo" -maxdepth 1 -type f | wc -l)" = 1 ]; then
  ok "sin destino conserva los binarios existentes sin instalar ni crear respaldos"
else
  bad "sin destino conserva los binarios existentes (rc=$rc): $err"
fi

[ "$fail" = 0 ] && echo "ALL OK"
exit "$fail"
