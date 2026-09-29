#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=${CAUCE_CONTAINER_OPS_ROOT:-$SCRIPT_ROOT}
if (( EUID == 0 )); then
  default_config_root=/etc/cauce-v3/container-aliases
  default_bundle_root=/opt/cauce-v3-adapter
  default_pki_root=/etc/cauce-v3/container-pki
  default_lock_root=/run/lock
else
  xdg_config_home=${XDG_CONFIG_HOME:-$HOME/.config}
  xdg_data_home=${XDG_DATA_HOME:-$HOME/.local/share}
  xdg_state_home=${XDG_STATE_HOME:-$HOME/.local/state}
  default_config_root="$xdg_config_home/cauce-v3/container-aliases"
  default_bundle_root="$xdg_data_home/cauce-v3-adapter"
  default_pki_root="$xdg_config_home/cauce-v3/container-pki"
  if [[ -n ${XDG_RUNTIME_DIR:-} ]]; then
    default_lock_root="$XDG_RUNTIME_DIR/cauce-v3"
  else
    default_lock_root="$xdg_state_home/cauce-v3/lock"
  fi
fi
CONFIG_ROOT=${CAUCE_CONTAINER_CONFIG_ROOT:-$default_config_root}
BUNDLE_ROOT=${CAUCE_CONTAINER_BUNDLE_ROOT:-$default_bundle_root}
PKI_ROOT=${CAUCE_CONTAINER_PKI_ROOT:-$default_pki_root}
LOCK_ROOT=${CAUCE_CONTAINER_LOCK_ROOT:-$default_lock_root}
RUNTIME_HELPER_SOURCE="$ROOT/container-runtime/cauce-container-runtime.py"
# The helper imports these siblings from its own directory: the container copy must carry all of them.
RUNTIME_HELPER_MODULES=(cauce_container_base.py cauce_container_proc.py cauce_container_tree.py)
MOUNT_VALIDATOR="$ROOT/scripts/validate-container-mount.py"
ALIAS_LOCK_EXEC="$ROOT/scripts/alias-lock-exec.py"
HERMES_RUNTIME_VERIFIER="$ROOT/scripts/verify-hermes-runtime.py"
SUPERVISOR_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/container-adapter-supervisor-lib.sh"
# shellcheck source=container-adapter-supervisor-lib.sh
source "$SUPERVISOR_LIB"
CONTROL_ROOT=/run/cauce-v3-supervisor
WAIT_SECONDS=60
DOCKER_CALL_TIMEOUT=${CAUCE_CONTAINER_DOCKER_TIMEOUT:-30}

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

# Every short-lived control-plane Docker call is bounded so a hung daemon/exec cannot wedge the
# supervisor. The long-running adapter exec at the end of start is intentionally NOT wrapped.
docker_control() { timeout -k 5 "$DOCKER_CALL_TIMEOUT" docker "$@"; }

if [[ ${CAUCE_CONTAINER_TEST_MODE:-0} == 1 ]]; then
  [[ $EUID -ne 0 || ${CAUCE_ALLOW_ROOT_TEST_MODE:-0} == 1 ]] || die 'test mode as root requires CAUCE_ALLOW_ROOT_TEST_MODE=1'
  CONFIG_ROOT=${CAUCE_CONTAINER_CONFIG_ROOT:?test config root is required}
  BUNDLE_ROOT=${CAUCE_CONTAINER_BUNDLE_ROOT:?test bundle root is required}
  PKI_ROOT=${CAUCE_CONTAINER_PKI_ROOT:?test PKI root is required}
  LOCK_ROOT=${CAUCE_CONTAINER_LOCK_ROOT:?test lock root is required}
  CONTROL_ROOT=${CAUCE_CONTAINER_CONTROL_ROOT:-$CONTROL_ROOT}
  WAIT_SECONDS=${CAUCE_CONTAINER_WAIT_SECONDS:-0}
fi
[[ $WAIT_SECONDS =~ ^[0-9]{1,3}$ && $WAIT_SECONDS -le 300 ]] || die 'container wait timeout is invalid'
[[ $DOCKER_CALL_TIMEOUT =~ ^[0-9]{1,4}$ && $DOCKER_CALL_TIMEOUT -ge 1 ]] || die 'docker call timeout is invalid'
command -v timeout >/dev/null 2>&1 || die 'timeout is unavailable' 127

valid_alias() {
  [[ $1 =~ ^[a-z][a-z0-9-]*$ ]]
}

valid_absolute_path() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ $1 != *'//'* && $1 != */../* && $1 != */./* && $1 != */.. && $1 != */. ]]
}

# Alias config paths must match separar-config-alias.mjs and remain isolated across shared HOME users.
# CONFIG_POR_ALIAS is opt-in; an empty or mismatched directory silently loads factory defaults.

config_por_alias_variable() {
  # Fails (does not return empty) for everything else: exporting `CODEX_HOME=` would be a variable that
  # exists and points nowhere, and the harness would resolve the factory directory without an error.
  case "$1" in
    claude) printf 'CLAUDE_CONFIG_DIR' ;;
    codex) printf 'CODEX_HOME' ;;
    *) return 1 ;;
  esac
}

config_por_alias_directorio() {
  local harness_de=$1 home_de=$2 alias_de=$3 subdirectorio
  case "$harness_de" in
    claude) subdirectorio=.claude ;;
    codex) subdirectorio=.codex ;;
    *) return 1 ;;
  esac
  valid_absolute_path "$home_de" || return 1
  valid_alias "$alias_de" || return 1
  printf '%s/.local/share/cauce-v3/config/%s/%s' "$home_de" "$alias_de" "$subdirectorio"
}

safe_owner_uid() {
  printf '%s\n' "$EUID"
}

assert_secure_file() {
  local path=$1 expected_mode=$2 label=$3 owner mode
  [[ -f $path && ! -L $path ]] || die "$label must be a regular non-symlink file"
  owner=$(stat -c '%u' "$path") || die "cannot inspect $label"
  mode=$(stat -c '%a' "$path") || die "cannot inspect $label"
  [[ $owner == "$(safe_owner_uid)" && $mode == "$expected_mode" ]] || die "$label must have the required owner and mode $expected_mode"
}

assert_secure_directory() {
  local path=$1 label=$2 owner mode numeric
  [[ -d $path && ! -L $path ]] || die "$label must be a non-symlink directory"
  owner=$(stat -c '%u' "$path") || die "cannot inspect $label"
  mode=$(stat -c '%a' "$path") || die "cannot inspect $label"
  numeric=$((8#$mode))
  [[ $owner == "$(safe_owner_uid)" && $((numeric & 8#022)) -eq 0 ]] || die "$label must have the required owner and not be group/world writable"
}

alias_name=${2:-}
valid_alias "$alias_name" || die 'invalid container adapter alias'
mapping_line=$(PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/container-alias-query.py" "$alias_name") || exit $?
IFS=$'\t' read -r tenant room container_name container_user container_home state_directory harness extra <<<"$mapping_line"
[[ -n $tenant && -n $room && -n $container_name && -n $container_user && -n $container_home \
  && -n $state_directory && -n $harness && -z ${extra:-} ]] \
  || die 'container alias mapping returned invalid fields'
valid_absolute_path "$container_home" || die 'mapped container home is invalid'
valid_absolute_path "$state_directory" || die 'mapped state directory is invalid'

# Policy facts that cannot fit in the seven-field legacy stdout above, from the same validated
# inventory (not the alias .env): cardinality decides isolation, workspace is compared byte-for-byte.
mapfile -t inventory_policy < <(PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT" "$alias_name" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts"))
from container_alias_lib import load_container_aliases  # noqa: E402

aliases = load_container_aliases(root)
entry = aliases[sys.argv[2]]
print(sum(candidate["container"] == entry["container"] for candidate in aliases.values()))
print(entry.get("workspace", ""))
PY
) || die 'cannot load alias isolation policy'
[[ ${#inventory_policy[@]} == 2 && ${inventory_policy[0]} =~ ^[1-9][0-9]*$ ]] \
  || die 'alias isolation policy is invalid'
physical_alias_count=${inventory_policy[0]}
inventory_workspace=${inventory_policy[1]}

config_file="$CONFIG_ROOT/$alias_name.env"
declare -A CONFIG=()
shared_session_disabled=false  # Set by validation when SHARED_SESSION cannot hold (grok without tmux).

load_config() {
  local line key value
  assert_secure_directory "$CONFIG_ROOT" 'container alias config root'
  assert_secure_file "$config_file" 600 'container alias config'
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line != *$'\r'* && $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die 'container alias config has invalid syntax'
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    [[ -n $value ]] || die "container alias config value is empty: $key"
    [[ ! -v "CONFIG[$key]" ]] || die "container alias config key is duplicated: $key"
    case "$key" in
      BUNDLE_RELEASE|BUNDLE_SHA256|PKI_DIR|RELAY_URL|EXPECTED_IMAGE_ID|EXPECTED_LABEL_KEY|EXPECTED_LABEL_VALUE|MOUNT_TYPE|MOUNT_SOURCE|MOUNT_NAME|MOUNT_DESTINATION|MOUNT_RW|DEFAULT_TIMEOUT_MS|CAUCE_SEMBRAR_PERFIL) ;;
      DECISIONES_URL) [[ $value =~ ^https://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$ ]] || die 'DECISIONES_URL must be a bare https origin' ;;
      CAUCE_NATIVE_PROFILE_CONTEXT) [[ $value =~ ^[01]$ ]] || die "CAUCE_NATIVE_PROFILE_CONTEXT must be exactly 0 or 1" ;;
      EXPECTED_CLI_VERSION) [[ $harness == claude ]] || die "config key is not allowed for $harness: $key" ;;
      HERMES_HOME|HERMES_INFERENCE_MODEL|HERMES_PYTHON|HERMES_SOURCE_COMMIT) [[ $harness == hermes ]] || die "config key is not allowed for $harness: $key" ;;
      # Shared session: the SAME conversation in owner's terminal and Telegram, only for claude/codex/grok/muse
      # (the harnesses with a shareable TUI); elsewhere it would lie about which mode it runs in.
      SHARED_SESSION|SHARED_SESSION_WORKSPACE)
        [[ $harness == claude || $harness == codex || $harness == grok || $harness == muse ]] || die "config key is not allowed for $harness: $key"
        ;;
      SHARED_SESSION_NATIVE_ID) [[ $harness == claude || $harness == grok || $harness == muse ]] || die "config key is not allowed for $harness: $key" ;;  # Seeded by the adapter (exact-resume harnesses).
      # Per-alias configuration: only for the two harnesses that read a directory governed by a
      # variable. hermes reads stdin and openclaw does not read ~/.codex or ~/.claude; accepting
      # the key there would export a variable nobody reads and claim a separated alias.
      CONFIG_POR_ALIAS)
        [[ $harness == claude || $harness == codex ]] || die "config key is not allowed for $harness: $key"
        ;;
      OPENCLAW_TRANSPORT|OPENCLAW_API_URL|OPENCLAW_TOKEN_FILE|OPENCLAW_AGENT_TARGET|OPENCLAW_DIST_DIR|OPENCLAW_WORKSPACE)
        [[ $harness == openclaw ]] || die "config key is not allowed for $harness: $key"
        ;;
      MUSE_EXECUTABLE|MUSE_CONFIG_HOME|MUSE_DATA_HOME|MUSE_WORKSPACE|MUSE_MODEL|MUSE_REASONING_EFFORT|MUSE_APPROVAL_MODE|MUSE_YOLO) [[ $harness == muse ]] || die "config key is not allowed for $harness: $key" ;;
      CLAUDE_PERMISSION_MODE) [[ $harness == claude ]] || die "config key is not allowed for $harness: $key" ;;
      CREDENTIAL_HOME)
        [[ $harness == claude || $harness == codex ]] || die "config key is not allowed for $harness: $key"
        ;;
      *) die "container alias config key is not allowlisted: $key" ;;
    esac
    CONFIG[$key]=$value
  done < "$config_file"
  for key in BUNDLE_RELEASE BUNDLE_SHA256 PKI_DIR RELAY_URL EXPECTED_IMAGE_ID; do
    [[ -v "CONFIG[$key]" ]] || die "container alias config is missing: $key"
  done
  validate_config_values
}

bundle_source=''
bundle_release=''
bundle_digest=''
bearer_token_present=false

container_id=''
container_generation=''
container_presence_generation=''
container_state_signature=''
container_running='false'
container_init_starttime=''

inspect_id_by_name() {
  local value
  value=$(docker_control inspect --format '{{.Id}}' "$container_name" 2>/dev/null) || return 1
  [[ $value =~ ^[a-f0-9]{64}$ ]] || return 1
  container_id=$value
}

read_state_signature() {
  local output running started restart extra
  output=$(docker_control inspect --format '{{.State.Running}} {{.State.StartedAt}} {{.RestartCount}}' "$container_id" 2>/dev/null) || return 1
  read -r running started restart extra <<<"$output"
  [[ $running == true || $running == false ]] || return 1
  [[ $started =~ ^[0-9T:.+-]+Z?$ && $restart =~ ^[0-9]+$ && -z ${extra:-} ]] || return 1
  printf '%s %s %s\n' "$running" "$started" "$restart"
}

set_generation_from_signature() {
  local running started restart extra
  read -r running started restart extra <<<"$container_state_signature"
  [[ -z ${extra:-} ]] || die 'container state signature is invalid' 75
  container_running=$running
  [[ $container_init_starttime =~ ^[0-9]+$ ]] || die 'container init starttime is invalid' 75
  container_generation=$(printf '%s\0%s\0%s\0%s' "$container_id" "$started" "$restart" "$container_init_starttime" | sha256sum)
  container_generation=${container_generation%% *}
  [[ $container_generation =~ ^[a-f0-9]{64}$ ]] || die 'container generation digest is invalid' 75
  container_presence_generation=$(printf '%s|%s|%s' "$container_id" "$started" "$restart" | sha256sum)
  [[ ${container_presence_generation%% *} =~ ^[a-f0-9]{64}$ ]] || die 'container presence generation digest is invalid' 75
  container_presence_generation=${container_presence_generation:0:32}
}

read_container_init_starttime() {
  docker_control exec "$container_id" /usr/bin/python3 -c \
    'raw=open("/proc/1/stat",encoding="utf-8").read(); fields=raw[raw.rfind(")")+2:].split(); print(fields[19])' 2>/dev/null
}

discover_container_once() {
  inspect_id_by_name || return 1
  container_state_signature=$(read_state_signature) || return 1
  container_init_starttime=$(read_container_init_starttime) || return 1
  [[ $container_init_starttime =~ ^[0-9]+$ ]] || return 1
  set_generation_from_signature
}

wait_for_container() {
  local attempt=0
  while (( attempt <= WAIT_SECONDS )); do
    if discover_container_once && [[ $container_running == true ]]; then return 0; fi
    (( attempt == WAIT_SECONDS )) && break
    sleep 1
    ((attempt += 1))
  done
  die "container is not running for alias $alias_name" 1
}

assert_generation() {
  local current current_init
  current=$(read_state_signature) || die 'container ID disappeared or became uninspectable' 75
  [[ $current == "$container_state_signature" ]] || die 'container generation changed during operation' 75
  current_init=$(read_container_init_starttime) || die 'container init generation became uninspectable' 75
  [[ $current_init == "$container_init_starttime" ]] || die 'container init generation changed during operation' 75
}

docker_id_exec() {
  local status
  assert_generation
  if [[ ${1:-} == --user ]]; then
    local user=$2
    shift 2
    if docker_control exec --user "$user" "$container_id" "$@"; then status=0; else status=$?; fi
  else
    if docker_control exec "$container_id" "$@"; then status=0; else status=$?; fi
  fi
  assert_generation
  return "$status"
}

docker_id_exec_stdin() {
  local status
  assert_generation
  if [[ ${1:-} == --user ]]; then
    local user=$2
    shift 2
    if docker_control exec -i --user "$user" "$container_id" "$@"; then status=0; else status=$?; fi
  else
    if docker_control exec -i "$container_id" "$@"; then status=0; else status=$?; fi
  fi
  assert_generation
  return "$status"
}

docker_id_cp() {
  local source=$1 destination=$2 status
  assert_generation
  if docker_control cp "$source" "$container_id:$destination"; then status=0; else status=$?; fi
  assert_generation
  return "$status"
}

docker_id_mutate() {
  local status user='0'
  if [[ ${1:-} == --user ]]; then user=$2; shift 2; fi
  assert_generation
  if docker_control exec --user "$user" "$container_id" /usr/bin/python3 "$control_helper" guard-exec \
    --init-starttime "$container_init_starttime" "$@"; then status=0; else status=$?; fi
  assert_generation
  return "$status"
}

discovered_mount_destination=''
validate_container_identity_and_mount() {
  local before image label template mount_json after runtime_path runtime_mount
  local mount_args=() runtime_paths=() shared_session_workspace=''
  before=$(read_state_signature) || die 'cannot inspect selected container ID' 75
  [[ $before == "$container_state_signature" ]] || die 'container changed before policy validation' 75
  image=$(docker_control inspect --format '{{.Image}}' "$container_id") || die 'cannot inspect container image' 75
  [[ $image == "${CONFIG[EXPECTED_IMAGE_ID]}" ]] || die 'container image ID is not allowlisted'
  # The container label is optional reinforcement (only some images carry a unique label).
  if [[ -v CONFIG[EXPECTED_LABEL_KEY] ]]; then
    template="{{index .Config.Labels \"${CONFIG[EXPECTED_LABEL_KEY]}\"}}"
    label=$(docker_control inspect --format "$template" "$container_id") || die 'cannot inspect required container label' 75
    [[ $label == "${CONFIG[EXPECTED_LABEL_VALUE]}" ]] || die 'container label is not allowlisted'
  fi
  mount_json=$(mktemp)
  docker_control inspect --format '{{json .Mounts}}' "$container_id" > "$mount_json" || { rm -f "$mount_json"; die 'cannot inspect structured container mounts' 75; }
  # The validator discovers the bind/volume that contains the state dir and echoes its
  # Destination; any declared MOUNT_* key is passed as optional reinforcement.
  [[ -v CONFIG[MOUNT_TYPE] ]] && mount_args+=(--type "${CONFIG[MOUNT_TYPE]}")
  [[ -v CONFIG[MOUNT_SOURCE] ]] && mount_args+=(--source "${CONFIG[MOUNT_SOURCE]}")
  [[ -v CONFIG[MOUNT_NAME] ]] && mount_args+=(--name "${CONFIG[MOUNT_NAME]}")
  [[ -v CONFIG[MOUNT_RW] ]] && mount_args+=(--rw "${CONFIG[MOUNT_RW]}")
  discovered_mount_destination=$(PYTHONDONTWRITEBYTECODE=1 python3 "$MOUNT_VALIDATOR" "$mount_json" "$state_directory" "${mount_args[@]}") \
    || { rm -f "$mount_json"; die 'container persistent mount policy differs'; }
  valid_absolute_path "$discovered_mount_destination" || die 'discovered persistent mount is invalid' 75
  [[ $state_directory == "$discovered_mount_destination" || $state_directory == "${discovered_mount_destination%/}/"* ]] \
    || die 'discovered persistent mount does not contain the alias state directory' 75
  if [[ -v CONFIG[MOUNT_DESTINATION] ]]; then
    [[ ${CONFIG[MOUNT_DESTINATION]} == "$discovered_mount_destination" ]] || die 'declared MOUNT_DESTINATION differs from the discovered persistent mount'
  fi

  # State persistence alone is insufficient: a recreate must also preserve every harness identity path
  # and every promised-durable workspace, validated against the same immutable inspect snapshot. This
  # catches /workspace surviving while CODEX_HOME lives in the writable layer, or a Hermes profile
  # surviving while its pinned source/venv does not.
  if [[ $harness == codex ]]; then
    runtime_paths+=("$container_home/.codex/auth.json" "$container_home/.codex/config.toml")
  elif [[ $harness == claude ]]; then
    runtime_paths+=("$container_home/.claude/.credentials.json" "$container_home/.claude.json")
  elif [[ $harness == hermes ]]; then
    # Only the mutable profile must live on a persistent mount. Source+venv deliberately live in
    # a root-owned immutable /opt release and are reproducibly reprovisioned after a recreate.
    runtime_paths+=("${CONFIG[HERMES_HOME]}")
  elif [[ $harness == openclaw ]]; then
    runtime_paths+=("${CONFIG[OPENCLAW_WORKSPACE]}")
  elif [[ $harness == grok ]]; then
    # ~/.grok holds the login (auth.json), the cauce MCP registration (config.toml) and the
    # per-cwd sessions that --resume reads: losing it on a recreate logs out and forks threads.
    runtime_paths+=("$container_home/.grok")
  elif [[ $harness == muse && -n $inventory_workspace ]]; then
    # Workspace agent: its isolated profile, data and workspace, plus the pinned executable.
    runtime_paths+=("${CONFIG[MUSE_CONFIG_HOME]}" "${CONFIG[MUSE_DATA_HOME]}" "${CONFIG[MUSE_WORKSPACE]}")
    docker_id_exec --user "$container_user" test -x "${CONFIG[MUSE_EXECUTABLE]}" >/dev/null 2>&1 || die 'Muse executable is missing inside the assigned container'
  elif [[ $harness == muse ]]; then
    # The alias's Muse folder holds its login (.config/muse, linked from ~/.config/muse) and, with
    # SHARED_SESSION, the conversations of its TUI (.local/share, the XDG_DATA_HOME the SDK derives).
    runtime_paths+=("$container_home/.local/share/cauce-v3/config/$alias_name")
  fi
  if [[ ${CONFIG[CONFIG_POR_ALIAS]:-} == 1 ]]; then
    runtime_path=$(config_por_alias_directorio "$harness" "$container_home" "$alias_name") \
      || { rm -f "$mount_json"; die 'cannot derive persistent alias configuration directory'; }
    runtime_paths+=("$runtime_path")
  fi
  # SHARED_SESSION always pins a workspace: undeclared gets the SDK's own default (config.ts).
  if [[ -v CONFIG[SHARED_SESSION] ]]; then
    shared_session_workspace=${CONFIG[SHARED_SESSION_WORKSPACE]:-/workspace}
    # grok in $HOME = its headless cwd: the conversation lives in ~/.grok (required above), not in the cwd.
    [[ $harness == grok && $shared_session_workspace == "$container_home" ]] || runtime_paths+=("$shared_session_workspace")
  fi
  for runtime_path in "${runtime_paths[@]}"; do
    runtime_mount=$(PYTHONDONTWRITEBYTECODE=1 python3 "$MOUNT_VALIDATOR" "$mount_json" "$runtime_path") \
      || { rm -f "$mount_json"; die 'a required harness path is not on persistent read-write storage'; }
    valid_absolute_path "$runtime_mount" \
      || { rm -f "$mount_json"; die 'a required harness mount is invalid' 75; }
  done
  rm -f "$mount_json"
  # On persistent storage does not mean created there; tmux accepts a bad `-c` and starts elsewhere.
  if [[ -n $shared_session_workspace ]]; then
    docker_id_exec test -d "$shared_session_workspace" >/dev/null 2>&1 \
      || die "SHARED_SESSION workspace does not exist inside the container: $shared_session_workspace"
    [[ $harness != grok && $harness != muse ]] || docker_id_exec sh -c 'command -v tmux' >/dev/null 2>&1 || { shared_session_disabled=true  # 78 left Telegram mute: headless.
      printf 'warning: SHARED_SESSION=1 ignored for %s: the container has no tmux; the adapter starts headless\n' "$alias_name" >&2; }
  fi
  after=$(read_state_signature) || die 'container disappeared during policy validation' 75
  [[ $after == "$before" ]] || die 'container generation changed during policy validation' 75
}

resolve_container_identity() {
  container_uid=$(docker_id_exec id -u "$container_user") || die 'mapped container user is unavailable' 1
  container_gid=$(docker_id_exec id -g "$container_user") || die 'mapped container group is unavailable' 1
  [[ $container_uid =~ ^[0-9]+$ && $container_gid =~ ^[0-9]+$ ]] || die 'container user identity is invalid' 1
  # The lifecycle controller runs as root and drops the adapter to this identity;
  # a root runtime user would collapse that boundary, so refuse it fail-closed.
  [[ $container_uid != 0 && $container_gid != 0 ]] || die 'container runtime identity must not be root' 78
}

instance_root="/opt/cauce-v3-adapter/$alias_name"
control_helper="$instance_root/cauce-container-runtime.py"
control_dir="$CONTROL_ROOT/$alias_name"
secret_directory="/opt/cauce-v3-secrets/$alias_name"
container_uid=''
container_gid=''

copy_control_helper() {
  docker_id_exec --user 0 mkdir -p "$instance_root"
  docker_id_cp "$RUNTIME_HELPER_SOURCE" "$control_helper"
  docker_id_exec --user 0 chown 0:0 "$control_helper"
  docker_id_exec --user 0 chmod 0555 "$control_helper"
  local module
  for module in "${RUNTIME_HELPER_MODULES[@]}"; do
    docker_id_cp "$ROOT/container-runtime/$module" "$instance_root/$module"
    docker_id_exec --user 0 chown 0:0 "$instance_root/$module"
    docker_id_exec --user 0 chmod 0444 "$instance_root/$module"
  done
}

prepare_control_securely() {
  # Root-owned 0700 control directory (tmpfs /run) for the lock and lifecycle
  # metadata, unwritable by the runtime user.
  docker_id_mutate --user 0 /usr/bin/python3 "$control_helper" prepare-control \
    --base "$CONTROL_ROOT" --alias "$alias_name"
}

prepare_state_securely() {
  # Bound safe state creation to the persistent mount discovered at validation time; the
  # helper creates every state component below it with O_NOFOLLOW and the runtime UID/GID.
  docker_id_mutate --user 0 /usr/bin/python3 "$control_helper" prepare-state \
    --mount "$discovered_mount_destination" --state "$state_directory" --uid "$container_uid" --gid "$container_gid"
}

ensure_claude_binary() {
  # For claude adapters: verify the binary against the alias-specific approved version. Containers
  # update independently, so a source-global version would fail healthy aliases on a newer image.
  # This does NOT install (pre-built into the container); it fails loudly on a version mismatch.
  if [[ $harness == claude ]]; then
    # shellcheck disable=SC2016
    docker_id_exec --user "$container_user" bash -c '
      set -euo pipefail
      home_dir="'"$container_home"'"
      required_ver="'"${CONFIG[EXPECTED_CLI_VERSION]}"'"

      # Check if claude binary exists at the expected location
      # resolve_claude_bin looks in ~/.local/bin first, then ~/.npm-global
      claude_bin=""
      [[ -x "$home_dir/.local/bin/claude" ]] && claude_bin="$home_dir/.local/bin/claude"
      [[ -z "$claude_bin" && -x "$home_dir/.npm-global/node_modules/@anthropic-ai/claude-code/bin/claude.exe" ]] && \
        claude_bin="$home_dir/.npm-global/node_modules/@anthropic-ai/claude-code/bin/claude.exe"

      if [[ -z "$claude_bin" ]]; then
        echo "FATAL: claude binary not found; required version $required_ver"
        exit 78
      fi

      # Extract version from binary output (--version returns "X.Y.Z ...")
      actual_ver=$("$claude_bin" --version 2>&1 | head -1 | grep -oE "^[0-9]+\.[0-9]+\.[0-9]+" || echo "unknown")
      if [[ "$actual_ver" != "$required_ver" ]]; then
        echo "FATAL: claude version mismatch: expected $required_ver but got $actual_ver from $claude_bin"
        exit 78
      fi
      exit 0
    ' || die "claude binary verification failed for $alias_name harness=claude; see log above"
  fi
}

ensure_hermes_runtime() {
  [[ $harness == hermes ]] || return 0
  # The exact same executable verifier is used by provisioning and every supervisor preflight: commit,
  # ignored/untracked entries, uv bytes, publish-last marker, ownership, modes, symlinks, import location.
  [[ -f $HERMES_RUNTIME_VERIFIER && ! -L $HERMES_RUNTIME_VERIFIER ]] \
    || die "Hermes runtime verifier is unavailable for $alias_name" 78
  docker_id_exec_stdin --user 0 /usr/bin/python3 - \
    --allowed-root "$hermes_runtime_root" --runtime-dir "$hermes_runtime_dir" \
    --source-commit "${CONFIG[HERMES_SOURCE_COMMIT]}" --package-version "$hermes_package_version" \
    --uv-version "$hermes_uv_version" --uv-target "$hermes_uv_target" \
    --uv-sha256 "$hermes_uv_sha" --uv-lock-sha256 "$hermes_uv_lock_sha" \
    --uv-archive-url "$hermes_uv_archive_url" --uv-archive-sha256 "$hermes_uv_archive_sha" \
    < "$HERMES_RUNTIME_VERIFIER" >/dev/null 2>&1 \
    || die "Hermes runtime verification failed for $alias_name (immutable release differs)" 78
  # shellcheck disable=SC2016
  docker_id_exec --user "$container_user" sh -c \
    'set -eu; cd "$1"; HERMES_HOME="$2" PYTHONDONTWRITEBYTECODE=1 "$3" -c '\''import hermes_cli.oneshot'\''' \
    sh "$hermes_source_dir" "${CONFIG[HERMES_HOME]}" "${CONFIG[HERMES_PYTHON]}" \
    >/dev/null 2>&1 \
    || die "Hermes runtime verification failed for $alias_name (profile/import unavailable)" 78
}

ensure_isolated_config() {
  [[ ${CONFIG[CONFIG_POR_ALIAS]:-} == 1 ]] || return 0
  local destination source identity required_one required_two optional=''
  destination=$(config_por_alias_directorio "$harness" "$container_home" "$alias_name") \
    || die "cannot derive isolated configuration for $alias_name" 78
  case "$harness" in
    codex)
      source="$container_home/.codex"
      identity=AGENTS.md
      required_one=config.toml
      required_two=auth.json
      ;;
    claude)
      source="$container_home/.claude"
      identity=CLAUDE.md
      required_one=.credentials.json
      required_two=.claude.json
      optional=settings.json
      ;;
    *) die "isolated configuration is unsupported for $harness" 78 ;;
  esac

  # Alias-specific MCP config and atomically refreshed credentials may be private files.
  docker_id_exec --user "$container_user" /usr/bin/python3 -c '
import os, stat, sys

destination, source, harness, identity, required_one, required_two, optional = sys.argv[1:]
uid = os.geteuid()

def regular_private_enough(path):
    details = os.lstat(path)
    return stat.S_ISREG(details.st_mode) and details.st_uid == uid and not (details.st_mode & 0o022)

def exact_link(name, source_path):
    destination_path = os.path.join(destination, name)
    details = os.lstat(destination_path)
    if not stat.S_ISLNK(details.st_mode) or details.st_uid != uid:
        raise SystemExit(1)
    if os.path.realpath(destination_path) != os.path.realpath(source_path):
        raise SystemExit(1)
    if not regular_private_enough(source_path):
        raise SystemExit(1)

directory = os.lstat(destination)
if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != uid or directory.st_mode & 0o022:
    raise SystemExit(1)
if not regular_private_enough(os.path.join(destination, identity)):
    raise SystemExit(1)
def private_file_or_link(name, source_path):
    details = os.lstat(os.path.join(destination, name))
    if stat.S_ISLNK(details.st_mode):
        exact_link(name, source_path)
    elif not regular_private_enough(os.path.join(destination, name)):
        raise SystemExit(1)

if harness == "codex":
    private_file_or_link(required_one, os.path.join(source, required_one))
    private_file_or_link(required_two, os.path.join(source, required_two))
else:
    private_file_or_link(required_one, os.path.join(source, required_one))
    private_file_or_link(required_two, os.path.join(os.path.dirname(source), required_two))
    source_optional = os.path.join(source, optional)
    destination_optional = os.path.join(destination, optional)
    if os.path.lexists(source_optional) or os.path.lexists(destination_optional):
        exact_link(optional, source_optional)
' "$destination" "$source" "$harness" "$identity" "$required_one" "$required_two" "$optional" \
    >/dev/null 2>&1 || die "isolated harness configuration verification failed for $alias_name" 78
}

stop_existing() {
  # Runs as root against the root-owned control directory; the fail-closed stop
  # proves absence when there is nothing to stop.
  docker_id_exec --user 0 /usr/bin/python3 "$control_helper" stop \
    --alias "$alias_name" --state "$state_directory" --control-dir "$control_dir" \
    --container-id "$container_id" --generation "$container_generation"
}

deploy_bundle() {
  local stage="$instance_root/.bundle-stage-$container_generation-$$" release="$instance_root/releases/$bundle_release" active
  docker_id_mutate --user 0 rm -rf "$stage"
  docker_id_mutate --user 0 mkdir -p "$stage" "$instance_root/releases"
  docker_id_cp "$bundle_source/." "$stage/"
  docker_id_mutate --user 0 chmod -R 'u=rX,go=rX' "$stage"
  docker_id_mutate --user 0 chown -R 0:0 "$stage"
  docker_id_mutate --user 0 rm -rf "$release"
  docker_id_mutate --user 0 mv "$stage" "$release"
  active=$(docker_id_exec --user "$container_uid:$container_gid" /usr/bin/python3 "$control_helper" bundle-digest "$release")
  [[ $active == "$bundle_digest" ]] || die 'copied active bundle digest differs' 78
  adapter_in_container="$release/packages/adapter-sdk/dist/src/bin/$harness.js"
  active_bundle_in_container=$release
  prune_bundle_cache
}

# La caché de releases del contenedor crecía una por despliegue (13 GB en vps-tn). Cada arranque recopia
# la release del staging del host, así que podar no pierde la reversa. Conserva la activa, las que usa un
# proceso vivo o nombra una config de arnés (MCP) y las CAUCE_BUNDLE_CACHE_KEEP (2) más recientes.
prune_bundle_cache() {
  local script="$ROOT/container-runtime/podar-releases.py" out
  [[ -f $script && ! -L $script ]] || return 0
  if out=$(docker_id_mutate --user 0 /usr/bin/python3 -c "$(cat "$script")" \
      "$instance_root/releases" "$bundle_release" "${CAUCE_BUNDLE_CACHE_KEEP:-2}" 2>&1); then
    printf '%s\n' "$out" >&2
  else
    printf 'warning: la poda de la cache de releases fallo y no bloquea el arranque: %s\n' "$out" >&2
  fi
}

deploy_pki() {
  local pki=${CONFIG[PKI_DIR]} stage="/opt/cauce-v3-secrets/.stage-$alias_name-$container_generation-$$" name
  docker_id_mutate --user 0 rm -rf "$stage"
  docker_id_mutate --user 0 mkdir -p "$stage"
  if [[ $harness == muse ]]; then
    for name in token client.crt client.key ca.crt; do [[ ! -f "$pki/$name" ]] || docker_id_cp "$pki/$name" "$stage/$name"; done
  else
    docker_id_cp "$pki/." "$stage/"
  fi
  docker_id_mutate --user 0 chown -R "$container_uid:$container_gid" "$stage"
  docker_id_mutate --user 0 chmod 0700 "$stage"
  for name in client.crt client.key ca.crt; do docker_id_mutate --user 0 chmod 0600 "$stage/$name"; done
  if [[ $bearer_token_present == true ]]; then docker_id_mutate --user 0 chmod 0600 "$stage/token"; fi
  if [[ $harness == openclaw && ${CONFIG[OPENCLAW_TRANSPORT]:-cli} == api ]]; then docker_id_mutate --user 0 chmod 0600 "$stage/openclaw-token"; fi
  docker_id_mutate --user 0 mkdir -p /opt/cauce-v3-secrets
  docker_id_mutate --user 0 chmod 0711 /opt/cauce-v3-secrets
  docker_id_mutate --user 0 rm -rf "$secret_directory"
  docker_id_mutate --user 0 mv "$stage" "$secret_directory"
}

preflight_adapter() {
  load_config
  validate_bundle
  wait_for_container
  validate_container_identity_and_mount
  validate_pki
  resolve_container_identity
  ensure_isolated_config
  ensure_claude_binary
  ensure_hermes_runtime
}

start_adapter() {
  local runtime_path effective_default_timeout_ms key
  command -v docker >/dev/null 2>&1 || die 'docker is unavailable' 127
  [[ -f $ALIAS_LOCK_EXEC && ! -L $ALIAS_LOCK_EXEC ]] || die 'alias lock helper is unavailable' 73
  if [[ -z ${CAUCE_ALIAS_LOCK_FD:-} ]]; then
    exec env CAUCE_CONTAINER_OPS_ROOT="$ROOT" CAUCE_CONTAINER_LOCK_ROOT="$LOCK_ROOT" \
      python3 "$ALIAS_LOCK_EXEC" run --lock-root "$LOCK_ROOT" --alias "$alias_name" -- \
      "$0" start "$alias_name"
  fi
  python3 "$ALIAS_LOCK_EXEC" verify --lock-root "$LOCK_ROOT" --alias "$alias_name" \
    || die "another supervisor owns alias $alias_name" 73
  preflight_adapter
  copy_control_helper
  prepare_control_securely
  prepare_state_securely
  stop_existing
  deploy_bundle
  deploy_pki
  runtime_path="$container_home/.local/bin:$container_home/.npm-global/bin:$container_home/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  if [[ -v CONFIG[DEFAULT_TIMEOUT_MS] ]]; then
    effective_default_timeout_ms=${CONFIG[DEFAULT_TIMEOUT_MS]}
  else
    effective_default_timeout_ms=86400000
  fi
  environment=(
    "HOME=$container_home" "USER=$container_user" "LOGNAME=$container_user" "PATH=$runtime_path"
    'LANG=C.UTF-8' 'LC_ALL=C.UTF-8' 'NODE_ENV=production' 'CAUCE_ENVIRONMENT=production'
    "CAUCE_TENANT=$tenant" "CAUCE_ROOM=$room" 'CAUCE_ORIGIN_TRANSPORT=telegram'
    "CAUCE_ALIAS=$alias_name" "CAUCE_INSTANCE_ID=systemd-container-$alias_name" "CAUCE_STATE_DIR=$state_directory"
    "CAUCE_CONTROL_DIR=$control_dir"
    "CAUCE_CONTAINER_ID=$container_id" "CAUCE_CONTAINER_GENERATION=$container_generation"
    "CAUCE_CONTAINER_PRESENCE_GENERATION=$container_presence_generation"
    "CAUCE_RELAY_URL=${CONFIG[RELAY_URL]}"
    "CAUCE_DEFAULT_TIMEOUT_MS=$effective_default_timeout_ms"
    "GIT_AUTHOR_NAME=$alias_name" "GIT_COMMITTER_NAME=$alias_name"
    "GIT_AUTHOR_EMAIL=${CONFIG[GIT_AUTHOR_EMAIL]:-34928585+stevenvo780@users.noreply.github.com}"
    "GIT_COMMITTER_EMAIL=${CONFIG[GIT_AUTHOR_EMAIL]:-34928585+stevenvo780@users.noreply.github.com}"
    "CAUCE_TLS_CERT_FILE=$secret_directory/client.crt" "CAUCE_TLS_KEY_FILE=$secret_directory/client.key" "CAUCE_TLS_CA_FILE=$secret_directory/ca.crt"
  )
  environment+=("CAUCE_SEMBRAR_PERFIL=${CONFIG[CAUCE_SEMBRAR_PERFIL]}")
  [[ ! -v CONFIG[DECISIONES_URL] ]] || environment+=("CAUCE_DECISIONES_URL=${CONFIG[DECISIONES_URL]}")
  [[ ! -v CONFIG[CAUCE_NATIVE_PROFILE_CONTEXT] ]] || environment+=("CAUCE_NATIVE_PROFILE_CONTEXT=${CONFIG[CAUCE_NATIVE_PROFILE_CONTEXT]}")
  if [[ -v CONFIG[CREDENTIAL_HOME] ]]; then
    valid_absolute_path "${CONFIG[CREDENTIAL_HOME]}" || die "CREDENTIAL_HOME must be a canonical absolute path"
    case "$harness" in
      codex) environment+=("CODEX_HOME=${CONFIG[CREDENTIAL_HOME]}") ;;
      claude) environment+=("CLAUDE_CONFIG_DIR=${CONFIG[CREDENTIAL_HOME]}") ;;
    esac
  fi
  if [[ -v CONFIG[CLAUDE_PERMISSION_MODE] ]]; then
    case "${CONFIG[CLAUDE_PERMISSION_MODE]}" in
      acceptEdits|auto|bypassPermissions|manual|dontAsk|plan) ;;
      *) die 'CLAUDE_PERMISSION_MODE is invalid' ;;
    esac
    environment+=("CAUCE_CLAUDE_PERMISSION_MODE=${CONFIG[CLAUDE_PERMISSION_MODE]}")
  fi
  if [[ $bearer_token_present == true ]]; then environment+=("CAUCE_TOKEN_FILE=$secret_directory/token"); fi
  if [[ -v CONFIG[SHARED_SESSION] && $shared_session_disabled != true ]]; then
    environment+=("CAUCE_SHARED_SESSION=${CONFIG[SHARED_SESSION]}")
    [[ -v CONFIG[SHARED_SESSION_WORKSPACE] ]] \
      && environment+=("CAUCE_SHARED_SESSION_WORKSPACE=${CONFIG[SHARED_SESSION_WORKSPACE]}")
    [[ -v CONFIG[SHARED_SESSION_NATIVE_ID] ]] && environment+=("CAUCE_SHARED_SESSION_NATIVE_ID=${CONFIG[SHARED_SESSION_NATIVE_ID]}")
    # tmux creates the session with this TERM. Without it the server is born with an unknown terminal
    # and the TUI renders broken for the owner, who is the one who joins afterwards.
    environment+=('TERM=xterm-256color'); [[ $harness != grok ]] || environment+=("GROK_HOME=$container_home/.grok")
  fi
  # Per-alias config is exported here, after the shared-session block: the TUI panel inherits this env,
  # so adapter and owner terminal resolve the SAME dir. OFF BY DEFAULT: over an empty dir it strips identity.
  # `env -i` keeps only the LAST repeat: the per-alias directory wins over CREDENTIAL_HOME, announced on stderr.
  if [[ -v CONFIG[CONFIG_POR_ALIAS] ]]; then
    per_alias_directory=$(config_por_alias_directorio "$harness" "$container_home" "$alias_name")
    [[ -v CONFIG[CREDENTIAL_HOME] && ${CONFIG[CREDENTIAL_HOME]} != "$per_alias_directory" ]] && printf 'warning: CONFIG_POR_ALIAS overrides CREDENTIAL_HOME for %s: %s -> %s\n' "$alias_name" "${CONFIG[CREDENTIAL_HOME]}" "$per_alias_directory" >&2
    environment+=("$(config_por_alias_variable "$harness")=$per_alias_directory")
  elif [[ ( $harness == claude || $harness == codex ) && ! -v CONFIG[CREDENTIAL_HOME] ]]; then
    # Without isolation, claude/codex use their default but do NOT EXPORT the var, and the pty-agent
    # runtime_facts measurement (it scans /proc for the observed profile) does not see it → 503 profile.
    [[ $harness == claude ]] && environment+=("CLAUDE_CONFIG_DIR=$container_home/.claude") || environment+=("CODEX_HOME=$container_home/.codex")
  fi
  if [[ $harness == hermes ]]; then
    environment+=("HERMES_HOME=${CONFIG[HERMES_HOME]}" "HERMES_INFERENCE_MODEL=${CONFIG[HERMES_INFERENCE_MODEL]}")
    environment+=("CAUCE_HERMES_RUNTIME_DIR=$hermes_runtime_dir")
    environment+=("CAUCE_HERMES_SOURCE_DIR=$hermes_source_dir")
    environment+=("CAUCE_HERMES_PYTHON=${CONFIG[HERMES_PYTHON]}")
  fi
  [[ $harness != openclaw ]] || environment+=("CAUCE_OPENCLAW_TRANSPORT=${CONFIG[OPENCLAW_TRANSPORT]:-cli}")
  for key in OPENCLAW_WORKSPACE OPENCLAW_API_URL OPENCLAW_TOKEN_FILE OPENCLAW_AGENT_TARGET OPENCLAW_DIST_DIR \
    MUSE_EXECUTABLE MUSE_CONFIG_HOME MUSE_DATA_HOME MUSE_WORKSPACE MUSE_APPROVAL_MODE MUSE_MODEL MUSE_REASONING_EFFORT MUSE_YOLO; do
    [[ ! -v "CONFIG[$key]" ]] || environment+=("CAUCE_$key=${CONFIG[$key]}")
  done
  [[ -z $inventory_workspace ]] || environment+=("CAUCE_AGENT_WORKSPACE=$inventory_workspace")
  assert_generation
  # The lifecycle controller runs as root (to own the control plane) and drops the
  # adapter child to the mapped non-root UID/GID. This exec is intentionally unbounded.
  exec docker exec -i --user 0 "$container_id" /usr/bin/python3 "$control_helper" guard-exec \
    --init-starttime "$container_init_starttime" /usr/bin/env -i "${environment[@]}" \
    /usr/bin/python3 "$control_helper" run --alias "$alias_name" --state "$state_directory" \
    --control-dir "$control_dir" --runtime-uid "$container_uid" --runtime-gid "$container_gid" \
    --container-id "$container_id" --generation "$container_generation" --bundle "$active_bundle_in_container" \
    --bundle-digest "$bundle_digest" "$adapter_in_container"
}

stop_adapter() {
  command -v docker >/dev/null 2>&1 || die 'docker is unavailable' 127
  inspect_id_by_name || return 0
  container_state_signature=$(read_state_signature) || return 0
  container_init_starttime=$(read_container_init_starttime) || return 0
  set_generation_from_signature
  [[ $container_running == true ]] || return 0
  docker_id_exec test -x "$control_helper" >/dev/null 2>&1 || die 'container lifecycle helper is absent; no signal was sent' 78
  docker_id_exec --user 0 /usr/bin/python3 "$control_helper" stop \
    --alias "$alias_name" --state "$state_directory" --control-dir "$control_dir" \
    --container-id "$container_id" --generation "$container_generation"
}

check_adapter() {
  command -v docker >/dev/null 2>&1 || die 'docker is unavailable' 127
  preflight_adapter
  docker_id_exec test -x "$control_helper" >/dev/null 2>&1 || die 'container lifecycle helper is absent' 78
  docker_id_exec --user 0 /usr/bin/python3 "$control_helper" check \
    --alias "$alias_name" --state "$state_directory" --control-dir "$control_dir" \
    --container-id "$container_id" --generation "$container_generation" \
    --bundle "$instance_root/releases/$bundle_release" --bundle-digest "$bundle_digest"
}

assert_adapter_stopped() {
  command -v docker >/dev/null 2>&1 || die 'docker is unavailable' 127
  inspect_id_by_name || die 'container is unavailable; stopped state cannot be proven' 78
  container_state_signature=$(read_state_signature) || die 'container generation is unavailable; stopped state cannot be proven' 78
  container_init_starttime=$(read_container_init_starttime) || die 'container init generation is unavailable; stopped state cannot be proven' 78
  set_generation_from_signature
  [[ $container_running == true ]] || die 'container is not running; stopped state cannot be proven' 78
  docker_id_exec test -x "$control_helper" >/dev/null 2>&1 || die 'container lifecycle helper is absent; stopped state cannot be proven' 78
  docker_id_exec --user 0 /usr/bin/python3 "$control_helper" stopped \
    --alias "$alias_name" --state "$state_directory" --control-dir "$control_dir" \
    --container-id "$container_id" --generation "$container_generation"
}

case "${1:-}" in
  start) start_adapter ;;
  stop) stop_adapter ;;
  check) check_adapter ;;
  stopped) assert_adapter_stopped ;;
  *) die 'usage: container-adapter-supervisor.sh start|stop|check|stopped ALIAS' ;;
esac
