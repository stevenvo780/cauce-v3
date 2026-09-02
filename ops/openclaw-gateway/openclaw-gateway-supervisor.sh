#!/usr/bin/env bash
# Supervisor for the OpenClaw gateway of an alias that lives INSIDE a container.
#
# WHY IT EXISTS
# --------------
# In `claw` the gateway is the container's PID 1: docker supervises it and jarvis gets it for free.
# In `ctrl-infra` the PID 1 is a `sleep infinity` with sshd next to it, so a gateway launched by
# hand there dies with the container and nobody restarts it. This script is the cheap equivalent:
# a systemd user unit on the host runs `docker exec` and systemd is the supervisor. There is no
# need to recreate the container, which is the only thing that would leave the PKI orphaned.
#
# THE TWO TRAPS IT SOLVES, AND WHY THEY CANNOT BE IGNORED
# ------------------------------------------------------------
# 1. `docker exec` does NOT propagate signals. If systemd kills the `docker exec` client, the
#    process INSIDE keeps running: the unit's `KillMode=control-group` only reaches the client,
#    so `stop` goes into the container and kills the tree itself.
# 2. When the gateway dies, orphan `claude -p` processes of ~330 MB each remain (measured). They
#    are not direct children: the descendant tree has to be walked via /proc. `stop` reaps them.
#
# AND THE TRAP THAT CANNOT BE CHECKED BY PROCESS NAME
# ------------------------------------------------------------
# `openclaw` is a wrapper that re-executes and leaves its argv as just "openclaw", so
# `pkill -f "openclaw gateway"` exits 0 without killing anything. Here we start
# `node .../dist/index.js gateway` (the exact argv of the gateway that already works in `claw`)
# and kill it by PID from a file; liveness is ALWAYS checked with a real TCP connection, never with `ps`.

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
  exit 78 # EX_CONFIG: the unit has RestartPreventExitStatus=78, it does not retry in a loop
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

in_container() { # runs inside the container as the alias's user, NO tty
  "${DOCKER}" exec -i --user "${RUNTIME_USER}" \
    -e HOME="${RUNTIME_HOME}" -e USER="${RUNTIME_USER}" -e LOGNAME="${RUNTIME_USER}" \
    "${CONTAINER}" "$@"
}

container_running() {
  [[ $("${DOCKER}" inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null) == "true" ]]
}

# Waits for the container to come back, instead of exiting with an error.
#
# Exiting with an error looks equivalent because the unit has Restart=always, but it is NOT:
# StartLimitBurst=10 with RestartSec=5s burns the retry budget in ~50 s and afterwards the unit
# stays `failed` forever. A recreated container takes longer than that, and then the durability
# —the entire reason for this unit— is lost precisely the day it is needed.
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

# The only accepted liveness check: a TCP connection that the server ACCEPTS.
# Not the PID file, not `ps`, not the process name. Exits 0 if it accepts.
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

# Kills the gateway AND all its descendants (the orphan `claude -p` processes). It walks /proc,
# which is the only source that does not lie when a process's argv changes underneath you.
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


def stat_fields(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as fh:
            raw = fh.read().decode("utf-8", "replace")
        tail = raw[raw.rindex(")") + 2:].split()
        comm = raw[raw.index("(") + 1:raw.rindex(")")]
        return tail, comm
    except Exception:
        return None


def ppid_of(pid):
    fields = stat_fields(pid)
    if fields is None:
        return None
    tail, _comm = fields
    return int(tail[1])


def identity(pid):  # (comm, starttime): the OS never reuses this pair for a live PID, unlike a bare PID number
    fields = stat_fields(pid)
    if fields is None:
        return None
    tail, comm = fields
    return (comm, tail[19])


def descendants(root):
    children = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        ppid = ppid_of(entry)
        if ppid is None:
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
identities = {pid: identity(pid) for pid in targets}  # snapshot now, while the walk just proved these are the intended PIDs


def kill_if_still_same(pid, sig, label):
    expected = identities.get(pid)
    if expected is None:
        return
    current = identity(pid)
    if current is None:
        return
    if current != expected:
        print(f"KILL_TREE: omito {label} a pid {pid}: identidad cambio (PID reciclado), no lo toco")
        return
    try:
        os.kill(pid, sig)
    except Exception:
        pass


for pid in targets:
    kill_if_still_same(pid, signal.SIGTERM, "SIGTERM")

deadline = time.time() + 12
while time.time() < deadline:
    if not any(alive(pid) for pid in targets):
        print("KILL_TREE: todo el arbol termino con SIGTERM")
        raise SystemExit(0)
    time.sleep(0.3)

leftovers = [pid for pid in targets if alive(pid)]
print(f"KILL_TREE: SIGKILL a los que sobrevivieron: {leftovers}")
for pid in leftovers:
    kill_if_still_same(pid, signal.SIGKILL, "SIGKILL")
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

  # A clean start begins by killing whatever was left over: systemd may have killed only the
  # `docker exec` client and left the gateway (and its `claude -p`) alive inside.
  kill_tree || true
  if accepts_connections; then
    echo "PUERTO_OCUPADO: 127.0.0.1:${PORT} sigue aceptando conexiones tras el barrido" >&2
    exit 75
  fi

  in_container mkdir -p "${RUN_DIR}"

  # `exec` keeps the `docker exec` client as the unit's main process: if the gateway inside
  # dies, this client exits and systemd restarts. Output goes to the unit's journal.
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
