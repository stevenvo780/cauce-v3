#!/usr/bin/env bash
# Supervisor del gateway de OpenClaw de un alias que vive DENTRO de un contenedor.
#
# POR QUE EXISTE
# --------------
# En `claw` el gateway es el PID 1 del contenedor: docker lo supervisa y jarvis lo tiene gratis.
# En `ctrl-infra` el PID 1 es un `sleep infinity` con sshd al lado, asi que un gateway lanzado a
# mano ahi muere con el contenedor y nadie lo vuelve a levantar. Este guion es el equivalente
# barato: una unit systemd de usuario en el host hace `docker exec` y systemd es el supervisor.
# No hace falta recrear el contenedor, que es lo unico que dejaria PKI huerfana.
#
# LAS DOS TRAMPAS QUE RESUELVE, Y POR QUE NO SE PUEDEN IGNORAR
# ------------------------------------------------------------
# 1. `docker exec` NO propaga senales. Si systemd mata al cliente `docker exec`, el proceso de
#    DENTRO sigue vivo: el `KillMode=control-group` de la unit solo alcanza al cliente. Por eso
#    `stop` no confia en la unit: entra al contenedor y mata el arbol el mismo.
# 2. Al morir el gateway quedan `claude -p` huerfanos de ~330 MB cada uno (medido). No son hijos
#    directos: hay que recorrer el arbol de descendientes por /proc. `stop` los recoge.
#
# Y LA TRAMPA QUE NO SE PUEDE COMPROBAR POR NOMBRE DE PROCESO
# ------------------------------------------------------------
# `openclaw` es un envoltorio que re-ejecuta y deja su argv en "openclaw" a secas, asi que un
# `pkill -f "openclaw gateway"` sale 0 sin matar nada. Aca se arranca `node .../dist/index.js
# gateway` (el argv exacto del gateway que ya funciona en `claw`) y se mata por PID de fichero,
# y la vida o muerte se comprueba SIEMPRE con una conexion TCP real, nunca con `ps`.

set -Eeuo pipefail

ACTION=${1:-}
ALIAS=${2:-}

if [[ -z ${ACTION} || -z ${ALIAS} ]]; then
  echo "uso: $(basename "$0") {start|stop|status} <alias>" >&2
  exit 2
fi

CONFIG_ROOT=${CAUCE_OPENCLAW_GATEWAY_CONFIG_ROOT:-${HOME}/.config/cauce-v3/openclaw-gateway}
CONFIG_FILE="${CONFIG_ROOT}/${ALIAS}.env"

if [[ ! -r ${CONFIG_FILE} ]]; then
  echo "GATEWAY_CONFIG_MISSING: no existe ${CONFIG_FILE}" >&2
  exit 78 # EX_CONFIG: la unit tiene RestartPreventExitStatus=78, no reintenta en bucle
fi

# shellcheck disable=SC1090
source "${CONFIG_FILE}"

CONTAINER=${CONTAINER:?CONTAINER es obligatorio en ${CONFIG_FILE}}
RUNTIME_USER=${RUNTIME_USER:?RUNTIME_USER es obligatorio en ${CONFIG_FILE}}
RUNTIME_HOME=${RUNTIME_HOME:-/home/${RUNTIME_USER}}
PORT=${PORT:-18789}
BIND=${BIND:-loopback}
OPENCLAW_ENTRY=${OPENCLAW_ENTRY:-/usr/lib/node_modules/openclaw/dist/index.js}
RUN_DIR=${RUN_DIR:-${RUNTIME_HOME}/.local/state/cauce-v3/openclaw-gateway-${ALIAS}}
PID_FILE="${RUN_DIR}/gateway.pid"

DOCKER=${DOCKER:-/usr/bin/docker}

in_container() { # ejecuta en el contenedor como el usuario del alias, SIN tty
  "${DOCKER}" exec -i --user "${RUNTIME_USER}" \
    -e HOME="${RUNTIME_HOME}" -e USER="${RUNTIME_USER}" -e LOGNAME="${RUNTIME_USER}" \
    "${CONTAINER}" "$@"
}

container_running() {
  [[ $("${DOCKER}" inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null) == "true" ]]
}

# Espera a que el contenedor vuelva, en vez de salir con error.
#
# Salir con error parece equivalente porque la unit tiene Restart=always, pero NO lo es:
# StartLimitBurst=10 con RestartSec=5s agota el presupuesto de reintentos en ~50 s y despues la
# unit se queda en `failed` para siempre. Un contenedor recreado tarda mas que eso, y entonces la
# durabilidad —el motivo entero de esta unit— se pierde justo el dia que hace falta.
wait_for_container() {
  local deadline=$(( SECONDS + ${CONTAINER_WAIT_SECONDS:-600} ))
  local announced=0
  while ! container_running; do
    if (( announced == 0 )); then
      echo "CONTAINER_DOWN: esperando a que ${CONTAINER} vuelva a estar corriendo..." >&2
      announced=1
    fi
    if (( SECONDS >= deadline )); then
      echo "CONTAINER_DOWN: ${CONTAINER} no volvio en ${CONTAINER_WAIT_SECONDS:-600}s" >&2
      return 1
    fi
    sleep 5
  done
  (( announced == 1 )) && echo "CONTAINER_UP: ${CONTAINER} disponible otra vez" >&2
  return 0
}

# Unica prueba de vida aceptada: una conexion TCP que el servidor ACEPTA.
# Ni el fichero de PID, ni `ps`, ni el nombre del proceso. Sale 0 si acepta.
accepts_connections() {
  in_container node -e '
const net = require("node:net");
const socket = net.connect(Number(process.argv[1]), "127.0.0.1");
socket.setTimeout(2500);
socket.on("connect", () => { socket.destroy(); process.exit(0); });
socket.on("error", () => process.exit(1));
socket.on("timeout", () => { socket.destroy(); process.exit(1); });
' "${PORT}" >/dev/null 2>&1
}

# Mata el gateway Y TODOS sus descendientes (los `claude -p` huerfanos). Recorre /proc, que es la
# unica fuente que no miente cuando el argv del proceso cambia debajo tuyo.
kill_tree() {
  in_container python3 - "${PID_FILE}" <<'PY'
import os, signal, sys, time

pid_file = sys.argv[1]
try:
    root = int(open(pid_file).read().strip())
except Exception:
    print("KILL_TREE: sin fichero de PID, nada que matar por arbol")
    raise SystemExit(0)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def descendants(root):
    children = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat", "rb") as fh:
                raw = fh.read().decode("utf-8", "replace")
            ppid = int(raw[raw.rindex(")") + 2:].split()[1])
        except Exception:
            continue
        children.setdefault(ppid, []).append(int(entry))
    out, stack = [], [root]
    while stack:
        current = stack.pop()
        for child in children.get(current, []):
            out.append(child)
            stack.append(child)
    return out


if not alive(root):
    print(f"KILL_TREE: pid {root} ya no existe")
    raise SystemExit(0)

targets = [root] + descendants(root)
print(f"KILL_TREE: objetivo raiz={root} descendientes={targets[1:]}")
for pid in targets:
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass

deadline = time.time() + 12
while time.time() < deadline:
    if not any(alive(pid) for pid in targets):
        print("KILL_TREE: todo el arbol termino con SIGTERM")
        raise SystemExit(0)
    time.sleep(0.3)

leftovers = [pid for pid in targets if alive(pid)]
print(f"KILL_TREE: SIGKILL a los que sobrevivieron: {leftovers}")
for pid in leftovers:
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass
time.sleep(0.5)
still = [pid for pid in targets if alive(pid)]
print(f"KILL_TREE: quedan vivos: {still}")
PY
}

case "${ACTION}" in
start)
  if ! wait_for_container; then
    exit 75 # EX_TEMPFAIL
  fi

  # Un arranque limpio empieza matando lo que haya quedado de antes: systemd puede haber matado
  # solo al cliente `docker exec` y dejado el gateway (y sus `claude -p`) vivos adentro.
  kill_tree || true
  if accepts_connections; then
    echo "PUERTO_OCUPADO: 127.0.0.1:${PORT} sigue aceptando conexiones tras el barrido" >&2
    exit 75
  fi

  in_container mkdir -p "${RUN_DIR}"

  # `exec` deja al cliente `docker exec` como proceso principal de la unit: si el gateway de
  # adentro muere, este cliente sale y systemd reinicia. La salida va al journal de la unit.
  exec "${DOCKER}" exec -i --user "${RUNTIME_USER}" \
    -e HOME="${RUNTIME_HOME}" -e USER="${RUNTIME_USER}" -e LOGNAME="${RUNTIME_USER}" \
    "${CONTAINER}" bash -s -- "${OPENCLAW_ENTRY}" "${PORT}" "${BIND}" "${PID_FILE}" <<'EOS'
set -u
entry=$1; port=$2; bind=$3; pid_file=$4
node "${entry}" gateway --bind "${bind}" --port "${port}" &
child=$!
printf '%s\n' "${child}" > "${pid_file}"
trap 'kill -TERM "${child}" 2>/dev/null || true' TERM INT
wait "${child}"
status=$?
rm -f "${pid_file}"
exit "${status}"
EOS
  ;;

stop)
  if ! container_running; then
    echo "CONTAINER_DOWN: ${CONTAINER} no esta corriendo; nada que parar"
    exit 0
  fi
  kill_tree || true
  if accepts_connections; then
    echo "STOP_INCOMPLETO: 127.0.0.1:${PORT} sigue aceptando conexiones" >&2
    exit 1
  fi
  echo "STOP_OK: 127.0.0.1:${PORT} ya no acepta conexiones"
  ;;

status)
  if ! container_running; then
    echo "gateway ${ALIAS}: contenedor ${CONTAINER} PARADO"
    exit 1
  fi
  if accepts_connections; then
    echo "gateway ${ALIAS}: ACEPTA en 127.0.0.1:${PORT} (${CONTAINER})"
    in_container sh -lc "ss -lntp 2>/dev/null | grep -w ${PORT} || true"
    exit 0
  fi
  echo "gateway ${ALIAS}: NO acepta en 127.0.0.1:${PORT} (${CONTAINER})"
  exit 1
  ;;

*)
  echo "accion desconocida: ${ACTION}" >&2
  exit 2
  ;;
esac
