#!/usr/bin/env bash
set -euo pipefail
umask 077

# Runs on kratos as the unprivileged `stev` user (member of the docker group). It publishes the
# PTY agent and its bundle inside the target container and then execs the agent as the mapped
# runtime UID. It never opens a listening socket: the agent dials OUT to the relay on agora,
# exactly like the container adapters already dial wss://100.64.0.6:8443/v3/ws.

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OPS_ROOT=${CAUCE_PTY_OPS_ROOT:-$(cd "$SCRIPT_ROOT/.." && pwd)}
xdg_config_home=${XDG_CONFIG_HOME:-$HOME/.config}
xdg_state_home=${XDG_STATE_HOME:-$HOME/.local/state}
CONFIG_ROOT=${CAUCE_PTY_CONFIG_ROOT:-$xdg_config_home/cauce-v3/pty}
PKI_ROOT=${CAUCE_PTY_PKI_ROOT:-$xdg_config_home/cauce-v3/pty-pki}
if [[ -n ${XDG_RUNTIME_DIR:-} ]]; then
  default_lock_root="$XDG_RUNTIME_DIR/cauce-v3"
else
  default_lock_root="$xdg_state_home/cauce-v3/lock"
fi
LOCK_ROOT=${CAUCE_PTY_LOCK_ROOT:-$default_lock_root}
AGENT_SOURCE="$SCRIPT_ROOT/cauce_pty_agent.py"
AGENT_VERSION=${CAUCE_PTY_AGENT_VERSION:-1}
DOCKER_CALL_TIMEOUT=${CAUCE_PTY_DOCKER_TIMEOUT:-30}

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

# Fallo TRANSITORIO: 75 (EX_TEMPFAIL) y, sobre todo, un codigo que NO esta en el
# `RestartPreventExitStatus=2 78` de la unit.
#
# Se separa de `die` porque los dos fallos NO son el mismo fallo. Un artefacto del release que no
# viajo (el agente, y cualquier fichero que se le sume) se arregla volviendo a desplegar, sin
# tocar systemd: si sale 2, las 15 unidades de PTY quedan PARADAS PARA SIEMPRE y ya no reintentan
# ni cuando el fichero vuelve. Un fallo de configuracion —un alias que no es un alias— si es
# permanente, y ese sigue saliendo por `die`.
die_transient() {
  printf '%s\n' "$1" >&2
  exit 75
}

# Every short-lived control-plane Docker call is bounded so a hung daemon cannot wedge the
# launcher. The final `docker exec` that becomes the agent is intentionally NOT wrapped.
docker_control() { timeout -k 5 "$DOCKER_CALL_TIMEOUT" docker "$@"; }

valid_alias() {
  [[ $1 =~ ^[a-z][a-z0-9-]*$ ]]
}

valid_absolute_path() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ $1 != *'//'* && $1 != */../* && $1 != */./* && $1 != */.. && $1 != */. ]]
}

assert_secure_file() {
  local path=$1 expected_mode=$2 label=$3 owner mode
  [[ -f $path && ! -L $path ]] || die "$label must be a regular non-symlink file"
  owner=$(stat -c '%u' "$path") || die "cannot inspect $label"
  mode=$(stat -c '%a' "$path") || die "cannot inspect $label"
  [[ $owner == "$EUID" && $mode == "$expected_mode" ]] || die "$label must be owned by the launcher user with mode $expected_mode"
}

assert_secure_directory() {
  local path=$1 label=$2 owner mode numeric
  [[ -d $path && ! -L $path ]] || die "$label must be a non-symlink directory"
  owner=$(stat -c '%u' "$path") || die "cannot inspect $label"
  mode=$(stat -c '%a' "$path") || die "cannot inspect $label"
  numeric=$((8#$mode))
  [[ $owner == "$EUID" && $((numeric & 8#022)) -eq 0 ]] || die "$label must be owned by the launcher user and not group/world writable"
}

alias_name=${1:-}
valid_alias "$alias_name" || die 'usage: cauce-pty-launcher.sh ALIAS'
command -v docker >/dev/null 2>&1 || die 'docker is unavailable' 127
command -v flock >/dev/null 2>&1 || die 'flock is unavailable' 127
command -v timeout >/dev/null 2>&1 || die 'timeout is unavailable' 127
[[ $DOCKER_CALL_TIMEOUT =~ ^[0-9]{1,4}$ && $DOCKER_CALL_TIMEOUT -ge 1 ]] || die 'docker call timeout is invalid'
[[ -f $AGENT_SOURCE && ! -L $AGENT_SOURCE ]] || die_transient 'PTY agent source is unavailable'

# 1. Alias -> container tuple. Read-only use of the fleet mapping owned by ops/scripts.
mapping_line=$(PYTHONDONTWRITEBYTECODE=1 python3 "$OPS_ROOT/scripts/container-alias-query.py" "$alias_name") || exit $?
IFS=$'\t' read -r tenant room container_name container_user container_home state_directory harness extra <<<"$mapping_line"
[[ -n $tenant && -n $room && -n $container_name && -n $container_user && -n $container_home \
  && -n $state_directory && -n $harness && -z ${extra:-} ]] \
  || die 'container alias mapping returned invalid fields'
valid_absolute_path "$container_home" || die 'mapped container home is invalid'

config_file="$CONFIG_ROOT/$alias_name.env"
declare -A CONFIG=()

load_config() {
  local line key value
  assert_secure_directory "$CONFIG_ROOT" 'PTY config root'
  assert_secure_file "$config_file" 600 'PTY alias config'
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line != *$'\r'* && $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die 'PTY alias config has invalid syntax'
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    [[ -n $value ]] || die "PTY alias config value is empty: $key"
    [[ ! -v "CONFIG[$key]" ]] || die "PTY alias config key is duplicated: $key"
    case "$key" in
      RELAY_HOST|RELAY_PORT|RELAY_SERVER_NAME|PKI_DIR|ALIAS_KEY_FILE|HARNESS_COMMAND|SHELL_CANDIDATES) ;;
      *) die "PTY alias config key is not allowlisted: $key" ;;
    esac
    CONFIG[$key]=$value
  done < "$config_file"
  for key in RELAY_HOST RELAY_PORT PKI_DIR ALIAS_KEY_FILE; do
    [[ -v "CONFIG[$key]" ]] || die "PTY alias config is missing: $key"
  done
  [[ ${CONFIG[RELAY_HOST]} =~ ^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$ ]] || die 'RELAY_HOST is invalid'
  [[ ${CONFIG[RELAY_PORT]} =~ ^[0-9]{1,5}$ && $((10#${CONFIG[RELAY_PORT]})) -ge 1 && $((10#${CONFIG[RELAY_PORT]})) -le 65535 ]] \
    || die 'RELAY_PORT is invalid'
  [[ ${CONFIG[RELAY_SERVER_NAME]:-x} =~ ^[A-Za-z0-9.:-]+$ ]] || die 'RELAY_SERVER_NAME is invalid'
  valid_absolute_path "${CONFIG[PKI_DIR]}" || die 'PKI_DIR path is invalid'
  [[ ${CONFIG[PKI_DIR]} == "$PKI_ROOT/$alias_name" ]] || die 'PKI_DIR is outside its alias-scoped path'
  valid_absolute_path "${CONFIG[ALIAS_KEY_FILE]}" || die 'ALIAS_KEY_FILE path is invalid'
  [[ ${CONFIG[ALIAS_KEY_FILE]} == "${CONFIG[PKI_DIR]}/alias-key.hex" ]] || die 'ALIAS_KEY_FILE must live inside PKI_DIR'
}

validate_channel_material() {
  local pki=${CONFIG[PKI_DIR]} name
  assert_secure_directory "$pki" 'PTY alias PKI directory'
  for name in client.crt client.key ca.crt; do
    assert_secure_file "$pki/$name" 600 "PTY channel material ($name)"
  done
  # The derived alias key is the agent's second, independent ticket check. It is per-alias, so it
  # cannot authorise any other agent even if kratos is fully compromised.
  assert_secure_file "${CONFIG[ALIAS_KEY_FILE]}" 400 'PTY alias key'
  [[ $(stat -c '%s' "${CONFIG[ALIAS_KEY_FILE]}") -ge 64 ]] || die 'PTY alias key file is too short to hold 32 bytes of hex'
}

container_id=''
container_image=''
container_generation=''

read_generation() {
  local output id image started restart running extra digest
  output=$(docker_control inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Running}}' "$container_name" 2>/dev/null) \
    || die "container is not inspectable for alias $alias_name" 1
  read -r id image started restart running extra <<<"$output"
  [[ $id =~ ^[a-f0-9]{64}$ ]] || die 'container id is invalid' 75
  [[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || die 'container image id is invalid' 75
  [[ $started =~ ^[0-9T:.+-]+Z?$ && $restart =~ ^[0-9]+$ && -z ${extra:-} ]] || die 'container state signature is invalid' 75
  [[ $running == true ]] || die "container is not running for alias $alias_name" 1
  # The generation binds this launch to one container incarnation: the ticket the gateway signs
  # names it, so a restart between issue and use invalidates every outstanding ticket.
  digest=$(printf '%s|%s|%s' "$id" "$started" "$restart" | sha256sum)
  digest=${digest%% *}
  [[ $digest =~ ^[a-f0-9]{64}$ ]] || die 'container generation digest is invalid' 75
  container_id=$id
  container_image=$image
  container_generation=${digest:0:32}
}

runtime_uid=''
runtime_gid=''

resolve_runtime_identity() {
  runtime_uid=$(docker_control exec "$container_id" id -u "$container_user") || die 'mapped container user is unavailable' 1
  runtime_gid=$(docker_control exec "$container_id" id -g "$container_user") || die 'mapped container group is unavailable' 1
  runtime_uid=${runtime_uid//[$'\r\n']/}
  runtime_gid=${runtime_gid//[$'\r\n']/}
  [[ $runtime_uid =~ ^[0-9]+$ && $runtime_gid =~ ^[0-9]+$ ]] || die 'container runtime identity is invalid' 1
  # The whole channel exists to give a shell as the mapped agent user. A root identity would
  # collapse that boundary, so refuse fail-closed with the supervisor's own code.
  [[ $runtime_uid != 0 && $runtime_gid != 0 ]] || die 'container runtime identity must not be root' 78
}

agent_path="/var/tmp/cauce-pty-agent-$alias_name.py"
bundle_path="/var/tmp/.cauce-pty-bundle-$alias_name.json"
local_bundle=''

cleanup() {
  [[ -n $local_bundle && -f $local_bundle ]] && rm -f -- "$local_bundle"
  return 0
}
trap cleanup EXIT

publish_agent() {
  # Root-owned and non-writable inside the container: the runtime user executes it but can never
  # rewrite it, so a compromised agent process cannot persist itself into the next launch.
  docker_control cp "$AGENT_SOURCE" "$container_id:$agent_path" || die 'cannot publish the PTY agent'
  docker_control exec --user 0 "$container_id" chown 0:0 "$agent_path" || die 'cannot own the published PTY agent'
  docker_control exec --user 0 "$container_id" chmod 0555 "$agent_path" || die 'cannot secure the published PTY agent'
}

# Socket de tmux de la flota. NO es el socket por defecto: `tmux ls` a secas no ve estas
# sesiones, que es por lo que la TUI de los agentes parecia no existir.
TMUX_SOCKET=${CAUCE_PTY_TMUX_SOCKET:-cauce}

# El modo `harness` del agente PTY es lo unico que emite la TUI que el agente YA esta corriendo;
# `shell` abre una terminal nueva, que no es lo que se pidio ver. Si el operador no declaro un
# HARNESS_COMMAND, se deriva de la sesion tmux viva del alias, MEDIDA dentro del contenedor y
# como el usuario del agente (el socket es por uid). Si no hay tmux o no hay sesion, se devuelve
# vacio y el agente sigue anunciando solo `shell`: no se inventa una TUI que no existe.
#
#   -r              cliente de SOLO LECTURA: desde la consola no se puede teclear en la TUI ajena.
#   -f ignore-size  el tamano del navegador no renegocia el de la sesion, asi mirar no le encoge
#                   el panel al humano que esta trabajando en esa misma tmux.
derive_harness_command() {
  local tmux_path session probe
  tmux_path=$(docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
    sh -c 'command -v tmux' 2>/dev/null) || return 1
  tmux_path=${tmux_path//[$'\r\n']/}
  [[ -n $tmux_path ]] || return 1
  valid_absolute_path "$tmux_path" || return 1
  session="cauce-$alias_name"
  # `has-session` es la comprobacion por EFECTO: existe el binario Y existe la sesion.
  probe=$(docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
    "$tmux_path" -L "$TMUX_SOCKET" has-session -t "=$session" 2>&1) || return 1
  [[ -z ${probe//[$'\r\n']/} ]] || return 1
  TMUX_PATH_FOUND=$tmux_path
  TMUX_SESSION_FOUND=$session
  return 0
}

# Entrada real de OpenClaw dentro del contenedor, y donde guarda sus conversaciones.
#
# Se invoca la entrada y no el envoltorio `openclaw`: ese re-ejecuta y deja su argv en «openclaw»
# a secas —por eso el supervisor del gateway tampoco lo usa— y un argv que no se puede reconocer
# no se puede supervisar ni auditar.
OPENCLAW_ENTRY=${CAUCE_PTY_OPENCLAW_ENTRY:-/usr/lib/node_modules/openclaw/dist/index.js}
OPENCLAW_SESSIONS_DIR=${CAUCE_PTY_OPENCLAW_SESSIONS_DIR:-.openclaw/agents/main/sessions}
OPENCLAW_HISTORY_LIMIT=${CAUCE_PTY_OPENCLAW_HISTORY_LIMIT:-200}

# La TUI NATIVA de OpenClaw, para los alias que no tienen panel tmux y no pueden tenerlo.
#
# El panel que hoy emiten 7 alias es el de la SESION COMPARTIDA, y esa existe solo para `claude` y
# `codex` (`SharedSessionHarness = Extract<HarnessId, "claude" | "codex">`). Un alias `openclaw` no
# levanta `cauce-<alias>` en tmux, y en sus imagenes ni siquiera hay tmux: su proceso es un demonio
# (`node .../openclaw/dist/index.js gateway`), no una pantalla. Por eso `derive_harness_command`
# devuelve vacio para siempre y la consola dice «Sin TUI que emitir».
#
# Pero OpenClaw SI trae una TUI, y es un CLIENTE del gateway que ese mismo alias ya corre en
# loopback. O sea que no hace falta tmux, ni una imagen nueva, ni un proceso supervisado mas: se
# lanza en el pty del agente como cualquier otro `harness_command`.
#
# El candado de solo lectura NO esta aca: la TUI de openclaw no tiene equivalente de `tmux -r`.
# Lo pone el agente PTY, que no escribe en el pty de un modo de visor (READ_ONLY_MODES).
#
# Todo se mide DENTRO del contenedor y como el usuario del alias. Cualquier duda devuelve vacio y
# el alias sigue anunciando solo `shell`, que es como esta hoy: el fallo caro no es quedarse sin
# TUI, es ANUNCIAR una que abre en negro y mandar al operador a creer que el agente esta colgado.
derive_openclaw_tui_command() {
  local node_path tui_help session_file session_key sessions_dir
  node_path=$(docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
    sh -c 'command -v node' 2>/dev/null) || return 1
  node_path=${node_path//[$'\r\n']/}
  valid_absolute_path "$node_path" || return 1

  docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
    test -f "$OPENCLAW_ENTRY" >/dev/null 2>&1 || return 1

  # Se le pregunta al binario INSTALADO si tiene la TUI y si acepta `--session`. openclaw se
  # actualiza solo, asi que la memoria de nadie sirve como fuente: el dia que el subcomando o el
  # flag cambien, esto deja de anunciar la TUI en vez de anunciar una pantalla vacia.
  tui_help=$(docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
    "$node_path" "$OPENCLAW_ENTRY" tui --help 2>/dev/null) || return 1
  [[ $tui_help == *"--session"* ]] || return 1

  # Cual sesion: la que el agente esta escribiendo AHORA, medida por fecha de modificacion sobre
  # su propio almacen. No sale de la configuracion porque no hay ninguna que la fije — openclaw no
  # tiene sesion compartida, asi que sus claves son una por conversacion.
  sessions_dir="$container_home/$OPENCLAW_SESSIONS_DIR"
  session_file=$(docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
    sh -c "ls -1t '$sessions_dir'/*.jsonl 2>/dev/null | head -n 1") || return 1
  session_file=${session_file//[$'\r\n']/}
  [[ -n $session_file ]] || return 1
  session_key=${session_file##*/}
  session_key=${session_key%.jsonl}
  # El nombre entra en un argv: un fichero llamado `; rm -rf /` no puede convertirse en argumento.
  [[ $session_key =~ ^[A-Za-z0-9._-]{1,200}$ ]] || return 1

  OPENCLAW_NODE_FOUND=$node_path
  OPENCLAW_SESSION_FOUND=$session_key
  return 0
}

publish_bundle() {
  local shell_candidates harness_command
  shell_candidates=${CONFIG[SHELL_CANDIDATES]:-'[["/bin/bash","-l"],["/bin/sh","-l"]]'}
  harness_command=${CONFIG[HARNESS_COMMAND]:-}
  if [[ -z $harness_command ]]; then
    TMUX_PATH_FOUND=''
    TMUX_SESSION_FOUND=''
    if derive_harness_command; then
      harness_command=$(CAUCE_TMUX_PATH=$TMUX_PATH_FOUND CAUCE_TMUX_SOCKET=$TMUX_SOCKET \
        CAUCE_TMUX_SESSION=$TMUX_SESSION_FOUND PYTHONDONTWRITEBYTECODE=1 python3 -c \
        'import json,os;print(json.dumps([os.environ["CAUCE_TMUX_PATH"],"-L",os.environ["CAUCE_TMUX_SOCKET"],"attach-session","-r","-f","ignore-size","-t",os.environ["CAUCE_TMUX_SESSION"]]))') \
        || die "cannot assemble the derived harness command"
      printf 'cauce-pty-launcher: harness derived from tmux alias=%s socket=%s session=%s\n' \
        "$alias_name" "$TMUX_SOCKET" "$TMUX_SESSION_FOUND" >&2
    else
      # Sin panel tmux se prueba la TUI nativa de OpenClaw. El orden importa y no se puede
      # invertir: un alias con sesion compartida tiene que seguir emitiendo el panel que su dueno
      # esta mirando, no otra cosa.
      OPENCLAW_NODE_FOUND=''
      OPENCLAW_SESSION_FOUND=''
      if derive_openclaw_tui_command; then
        harness_command=$(CAUCE_OPENCLAW_NODE=$OPENCLAW_NODE_FOUND CAUCE_OPENCLAW_ENTRY=$OPENCLAW_ENTRY \
          CAUCE_OPENCLAW_SESSION=$OPENCLAW_SESSION_FOUND CAUCE_OPENCLAW_HISTORY=$OPENCLAW_HISTORY_LIMIT \
          PYTHONDONTWRITEBYTECODE=1 python3 -c \
          'import json,os;print(json.dumps([os.environ["CAUCE_OPENCLAW_NODE"],os.environ["CAUCE_OPENCLAW_ENTRY"],"tui","--session",os.environ["CAUCE_OPENCLAW_SESSION"],"--history-limit",os.environ["CAUCE_OPENCLAW_HISTORY"]]))') \
          || die "cannot assemble the derived openclaw harness command"
        printf 'cauce-pty-launcher: harness derived from openclaw tui alias=%s session=%s\n' \
          "$alias_name" "$OPENCLAW_SESSION_FOUND" >&2
      else
        harness_command=null
        printf 'cauce-pty-launcher: no live tmux session and no openclaw tui for alias=%s socket=%s; agent will publish shell only\n' \
          "$alias_name" "$TMUX_SOCKET" >&2
      fi
    fi
  fi
  local_bundle=$(mktemp "${TMPDIR:-/tmp}/.cauce-pty-bundle-$alias_name.XXXXXX")
  chmod 0600 "$local_bundle"
  CAUCE_PTY_BUNDLE_TENANT=$tenant \
  CAUCE_PTY_BUNDLE_ALIAS=$alias_name \
  CAUCE_PTY_BUNDLE_CONTAINER=$container_id \
  CAUCE_PTY_BUNDLE_GENERATION=$container_generation \
  CAUCE_PTY_BUNDLE_IMAGE=$container_image \
  CAUCE_PTY_BUNDLE_USER=$container_user \
  CAUCE_PTY_BUNDLE_UID=$runtime_uid \
  CAUCE_PTY_BUNDLE_GID=$runtime_gid \
  CAUCE_PTY_BUNDLE_HOME=$container_home \
  CAUCE_PTY_BUNDLE_HARNESS=$harness \
  CAUCE_PTY_BUNDLE_RELAY_HOST=${CONFIG[RELAY_HOST]} \
  CAUCE_PTY_BUNDLE_RELAY_PORT=${CONFIG[RELAY_PORT]} \
  CAUCE_PTY_BUNDLE_RELAY_SERVER_NAME=${CONFIG[RELAY_SERVER_NAME]:-} \
  CAUCE_PTY_BUNDLE_PKI_DIR=${CONFIG[PKI_DIR]} \
  CAUCE_PTY_BUNDLE_KEY_FILE=${CONFIG[ALIAS_KEY_FILE]} \
  CAUCE_PTY_BUNDLE_SHELLS=$shell_candidates \
  CAUCE_PTY_BUNDLE_HARNESS_COMMAND=$harness_command \
  CAUCE_PTY_BUNDLE_VERSION=$AGENT_VERSION \
  PYTHONDONTWRITEBYTECODE=1 python3 - > "$local_bundle" <<'PYTHON'
import json, os, sys

# Assembled by Python (never by shell string concatenation) so a certificate with any byte in it
# still produces valid JSON. Nothing is echoed: the document only goes to the 0600 temp file.
pki = os.environ["CAUCE_PTY_BUNDLE_PKI_DIR"]


def read(path):
    with open(path, encoding="utf-8") as stream:
        return stream.read()


def commands(raw, label):
    try:
        value = json.loads(raw)
    except ValueError:
        raise SystemExit(f"{label} is not valid JSON")
    return value


document = {
    "tenant_id": os.environ["CAUCE_PTY_BUNDLE_TENANT"],
    "alias": os.environ["CAUCE_PTY_BUNDLE_ALIAS"],
    "container_id": os.environ["CAUCE_PTY_BUNDLE_CONTAINER"],
    "generation": os.environ["CAUCE_PTY_BUNDLE_GENERATION"],
    "image_id": os.environ["CAUCE_PTY_BUNDLE_IMAGE"],
    "runtime_user": os.environ["CAUCE_PTY_BUNDLE_USER"],
    "runtime_uid": int(os.environ["CAUCE_PTY_BUNDLE_UID"]),
    "runtime_gid": int(os.environ["CAUCE_PTY_BUNDLE_GID"]),
    "home": os.environ["CAUCE_PTY_BUNDLE_HOME"],
    "shell_candidates": commands(os.environ["CAUCE_PTY_BUNDLE_SHELLS"], "SHELL_CANDIDATES"),
    "harness_command": commands(os.environ["CAUCE_PTY_BUNDLE_HARNESS_COMMAND"], "HARNESS_COMMAND"),
    "harness": os.environ["CAUCE_PTY_BUNDLE_HARNESS"],
    "relay_host": os.environ["CAUCE_PTY_BUNDLE_RELAY_HOST"],
    "relay_port": int(os.environ["CAUCE_PTY_BUNDLE_RELAY_PORT"]),
    "alias_key_hex": read(os.environ["CAUCE_PTY_BUNDLE_KEY_FILE"]).strip(),
    "client_cert_pem": read(os.path.join(pki, "client.crt")),
    "client_key_pem": read(os.path.join(pki, "client.key")),
    "ca_pem": read(os.path.join(pki, "ca.crt")),
    "agent_version": os.environ["CAUCE_PTY_BUNDLE_VERSION"],
}
server_name = os.environ.get("CAUCE_PTY_BUNDLE_RELAY_SERVER_NAME", "")
if server_name:
    document["relay_server_name"] = server_name
if len(document["alias_key_hex"]) != 64:
    raise SystemExit("alias key must be 64 hex characters")
json.dump(document, sys.stdout, separators=(",", ":"), sort_keys=True)
PYTHON
  [[ -s $local_bundle ]] || die 'PTY bundle could not be assembled'
  docker_control cp "$local_bundle" "$container_id:$bundle_path" || die 'cannot publish the PTY bundle'
  rm -f -- "$local_bundle"
  local_bundle=''
  docker_control exec --user 0 "$container_id" chown "$runtime_uid:$runtime_gid" "$bundle_path" || die 'cannot own the published PTY bundle'
  docker_control exec --user 0 "$container_id" chmod 0400 "$bundle_path" || die 'cannot secure the published PTY bundle'
  # Only names, owner and mode: the bundle body (channel key, certificate, alias key) is never printed.
  printf 'cauce-pty-launcher: bundle published alias=%s path=%s owner=%s:%s mode=0400\n' \
    "$alias_name" "$bundle_path" "$runtime_uid" "$runtime_gid" >&2
}

start_agent() {
  local lock_file previous_generation
  if [[ ! -e $LOCK_ROOT ]]; then
    mkdir -p -- "$LOCK_ROOT" || die 'PTY lock root cannot be created'
    chmod 0700 "$LOCK_ROOT" || die 'PTY lock root cannot be secured'
  fi
  assert_secure_directory "$LOCK_ROOT" 'PTY lock root'
  lock_file="$LOCK_ROOT/cauce-v3-pty-$alias_name.lock"
  exec 9>"$lock_file"
  flock -n 9 || die "another PTY launcher owns alias $alias_name" 73
  load_config
  validate_channel_material
  read_generation
  previous_generation=$container_generation
  resolve_runtime_identity
  publish_agent
  publish_bundle
  # Re-verify the incarnation: if the container restarted while we were copying, the published
  # bundle names a generation that no longer exists and no ticket for it can ever verify, so the
  # only safe move is to abort and let systemd start a fresh launch.
  read_generation
  [[ $container_generation == "$previous_generation" ]] || die 'container generation changed during publication' 75
  printf 'cauce-pty-launcher: exec agent alias=%s container=%s generation=%s uid=%s\n' \
    "$alias_name" "${container_id:0:12}" "$container_generation" "$runtime_uid" >&2
  exec docker exec -i --user "$runtime_uid:$runtime_gid" "$container_id" \
    /usr/bin/python3 "$agent_path" --bundle "$bundle_path"
}

start_agent
