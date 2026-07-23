#!/usr/bin/env bash
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
MOUNT_VALIDATOR="$ROOT/scripts/validate-container-mount.py"
CONTROL_ROOT=/run/cauce-v3-supervisor
WAIT_SECONDS=60
DOCKER_CALL_TIMEOUT=${CAUCE_CONTAINER_DOCKER_TIMEOUT:-30}

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

# Every short-lived control-plane Docker call is bounded so a hung daemon/exec
# cannot wedge the supervisor. The long-running adapter exec at the end of start
# is intentionally NOT wrapped (it must run unbounded).
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

config_file="$CONFIG_ROOT/$alias_name.env"
declare -A CONFIG=()

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
      BUNDLE_CURRENT|BUNDLE_SHA256|PKI_DIR|RELAY_URL|EXPECTED_IMAGE_ID|EXPECTED_LABEL_KEY|EXPECTED_LABEL_VALUE|MOUNT_TYPE|MOUNT_SOURCE|MOUNT_NAME|MOUNT_DESTINATION|MOUNT_RW) ;;
      HERMES_HOME|HERMES_INFERENCE_MODEL|HERMES_PYTHON) [[ $harness == hermes ]] || die "config key is not allowed for $harness: $key" ;;
      OPENCLAW_TRANSPORT|OPENCLAW_API_URL|OPENCLAW_TOKEN_FILE|OPENCLAW_AGENT_TARGET|OPENCLAW_DIST_DIR)
        [[ $harness == openclaw ]] || die "config key is not allowed for $harness: $key"
        ;;
      *) die "container alias config key is not allowlisted: $key" ;;
    esac
    CONFIG[$key]=$value
  done < "$config_file"
  for key in BUNDLE_CURRENT BUNDLE_SHA256 PKI_DIR RELAY_URL EXPECTED_IMAGE_ID; do
    [[ -v "CONFIG[$key]" ]] || die "container alias config is missing: $key"
  done
  validate_config_values
}

validate_relay_url() {
  local value=$1 authority port
  [[ $value =~ ^wss://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:([0-9]{1,5}))?(/[A-Za-z0-9._~%/-]*)?$ ]] \
    || die 'RELAY_URL must be a credential-free wss URL without query or fragment'
  port=${BASH_REMATCH[3]:-}
  authority=${value#wss://}; authority=${authority%%/*}
  [[ $authority != *@* ]] || die 'RELAY_URL userinfo is forbidden'
  [[ -z $port || $((10#$port)) -le 65535 ]] || die 'RELAY_URL port is invalid'
}

validate_config_values() {
  local expected_bundle="$BUNDLE_ROOT/current" expected_pki="$PKI_ROOT/$alias_name" api_authority api_port
  valid_absolute_path "${CONFIG[BUNDLE_CURRENT]}" || die 'BUNDLE_CURRENT path is invalid'
  valid_absolute_path "${CONFIG[PKI_DIR]}" || die 'PKI_DIR path is invalid'
  [[ ${CONFIG[BUNDLE_CURRENT]} == "$expected_bundle" ]] || die 'BUNDLE_CURRENT is outside its allowlisted path'
  [[ ${CONFIG[PKI_DIR]} == "$expected_pki" ]] || die 'PKI_DIR is outside its alias-scoped path'
  [[ ${CONFIG[BUNDLE_SHA256]} =~ ^sha256:[a-f0-9]{64}$ ]] || die 'BUNDLE_SHA256 must be an exact sha256 digest'
  [[ ${CONFIG[EXPECTED_IMAGE_ID]} =~ ^sha256:[a-f0-9]{64}$ ]] || die 'EXPECTED_IMAGE_ID must be an exact image ID'
  # Optional container-label reinforcement: declare both key and value, or neither.
  if [[ -v CONFIG[EXPECTED_LABEL_KEY] || -v CONFIG[EXPECTED_LABEL_VALUE] ]]; then
    [[ -v CONFIG[EXPECTED_LABEL_KEY] && -v CONFIG[EXPECTED_LABEL_VALUE] ]] || die 'EXPECTED_LABEL_KEY and EXPECTED_LABEL_VALUE must be set together'
    [[ ${CONFIG[EXPECTED_LABEL_KEY]} =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] || die 'EXPECTED_LABEL_KEY is invalid'
    [[ ${CONFIG[EXPECTED_LABEL_VALUE]} =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$ ]] || die 'EXPECTED_LABEL_VALUE is invalid'
  fi
  # Optional persistent-mount reinforcement. The supervisor discovers, from `docker inspect`,
  # the bind/volume that CONTAINS the alias state directory; these keys only re-verify it.
  if [[ -v CONFIG[MOUNT_TYPE] ]]; then
    case "${CONFIG[MOUNT_TYPE]}" in bind|volume) ;; *) die 'MOUNT_TYPE must be bind or volume' ;; esac
  fi
  if [[ -v CONFIG[MOUNT_SOURCE] ]]; then
    valid_absolute_path "${CONFIG[MOUNT_SOURCE]}" || die 'MOUNT_SOURCE must be a canonical absolute path'
  fi
  if [[ -v CONFIG[MOUNT_DESTINATION] ]]; then
    valid_absolute_path "${CONFIG[MOUNT_DESTINATION]}" || die 'MOUNT_DESTINATION must be a canonical absolute path'
    [[ $state_directory == "${CONFIG[MOUNT_DESTINATION]}" || $state_directory == "${CONFIG[MOUNT_DESTINATION]%/}/"* ]] \
      || die 'MOUNT_DESTINATION must contain the alias state directory'
  fi
  if [[ -v CONFIG[MOUNT_RW] ]]; then
    [[ ${CONFIG[MOUNT_RW]} == true ]] || die 'MOUNT_RW must be true for a persistent state mount'
  fi
  if [[ -v CONFIG[MOUNT_NAME] ]]; then
    [[ ${CONFIG[MOUNT_TYPE]:-} == volume ]] || die 'MOUNT_NAME is only valid together with MOUNT_TYPE=volume'
    [[ ${CONFIG[MOUNT_NAME]} =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die 'MOUNT_NAME is invalid'
  fi
  validate_relay_url "${CONFIG[RELAY_URL]}"
  if [[ $harness == hermes ]]; then
    # HERMES_HOME is either the mapped .hermes home or a profile subdirectory below it
    # (e.g. .hermes/profiles/<alias>). valid_absolute_path forbids .././/. components, so the
    # "$container_home/.hermes/" prefix cannot be escaped and sibling paths (.hermesX) are rejected.
    valid_absolute_path "${CONFIG[HERMES_HOME]:-}" || die 'HERMES_HOME must be a canonical absolute path'
    [[ ${CONFIG[HERMES_HOME]} == "$container_home/.hermes" || ${CONFIG[HERMES_HOME]} == "$container_home/.hermes/"* ]] \
      || die 'HERMES_HOME must be the mapped .hermes home or a subdirectory below it'
    [[ ${CONFIG[HERMES_INFERENCE_MODEL]:-} =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]] || die 'HERMES_INFERENCE_MODEL is invalid'
    # HERMES_PYTHON is optional: when unset the adapter keeps its default interpreter (unchanged
    # behaviour). When set it must be a canonical absolute path that lives under the mapped
    # container home (e.g. a venv interpreter below $container_home that provides hermes_cli), so
    # it can never point at an arbitrary host/system binary. valid_absolute_path already forbids
    # .././/. traversal, so the "$container_home/" prefix cannot be escaped.
    if [[ -v CONFIG[HERMES_PYTHON] ]]; then
      valid_absolute_path "${CONFIG[HERMES_PYTHON]}" || die 'HERMES_PYTHON must be a canonical absolute path'
      [[ ${CONFIG[HERMES_PYTHON]} == "$container_home/"* ]] || die 'HERMES_PYTHON must live under the mapped container home'
    fi
  fi
  if [[ $harness == openclaw ]]; then
    case "${CONFIG[OPENCLAW_TRANSPORT]:-cli}" in
      cli)
        [[ ! -v CONFIG[OPENCLAW_API_URL] && ! -v CONFIG[OPENCLAW_TOKEN_FILE] ]] || die 'OpenClaw API URL/token file require API transport'
        ;;
      api)
        [[ ${CONFIG[OPENCLAW_API_URL]:-} =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/v1/chat/completions$ ]] || die 'OPENCLAW_API_URL must be the verified loopback endpoint'
        api_authority=${CONFIG[OPENCLAW_API_URL]#*://}; api_authority=${api_authority%%/*}; api_port=${api_authority##*:}
        [[ $api_port == "$api_authority" || $((10#$api_port)) -le 65535 ]] || die 'OPENCLAW_API_URL port is invalid'
        [[ ${CONFIG[OPENCLAW_TOKEN_FILE]:-} == "/opt/cauce-v3-secrets/$alias_name/openclaw-token" ]] || die 'OPENCLAW_TOKEN_FILE must use the alias-scoped copied file'
        ;;
      *) die 'OPENCLAW_TRANSPORT must be cli or api' ;;
    esac
    if [[ -v CONFIG[OPENCLAW_AGENT_TARGET] ]]; then
      [[ ${CONFIG[OPENCLAW_AGENT_TARGET]} =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] || die 'OPENCLAW_AGENT_TARGET is invalid'
    fi
    if [[ -v CONFIG[OPENCLAW_DIST_DIR] ]]; then
      # OPENCLAW_DIST_DIR is a non-secret module-discovery directory inside the container. It may
      # live under the user home OR be a global install (e.g. /usr/lib/node_modules/openclaw/dist),
      # so only require a canonical absolute path; valid_absolute_path forbids .././/. traversal.
      valid_absolute_path "${CONFIG[OPENCLAW_DIST_DIR]}" || die 'OPENCLAW_DIST_DIR path is invalid'
    fi
  fi
}

bundle_source=''
bundle_release=''
bundle_digest=''
bearer_token_present=false
validate_bundle() {
  local current=${CONFIG[BUNDLE_CURRENT]} owner mode numeric adapter invalid link resolved calculated
  [[ -x $RUNTIME_HELPER_SOURCE && -f $RUNTIME_HELPER_SOURCE ]] || die 'container runtime helper is unavailable'
  [[ -L $current ]] || die 'BUNDLE_CURRENT must be an immutable current symlink'
  owner=$(stat -c '%u' "$current") || die 'cannot inspect BUNDLE_CURRENT'
  [[ $owner == "$(safe_owner_uid)" ]] || die 'BUNDLE_CURRENT must have the required owner'
  bundle_source=$(readlink -f "$current") || die 'BUNDLE_CURRENT target is unavailable'
  [[ -d $bundle_source && ! -L $bundle_source && ${bundle_source%/*} == "$BUNDLE_ROOT/releases" ]] || die 'BUNDLE_CURRENT must resolve to one direct release directory'
  bundle_release=${bundle_source##*/}
  [[ $bundle_release =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && $bundle_release != current ]] || die 'bundle release name is invalid'
  owner=$(stat -c '%u' "$bundle_source") || die 'cannot inspect bundle release'
  mode=$(stat -c '%a' "$bundle_source") || die 'cannot inspect bundle release'
  numeric=$((8#$mode))
  [[ $owner == "$(safe_owner_uid)" && $((numeric & 8#222)) -eq 0 ]] || die 'bundle release must be owned correctly and immutable'
  invalid=$(find "$bundle_source" -xdev \( -type f -o -type d \) \( ! -uid "$owner" -o -perm /222 \) -print -quit) || die 'cannot validate immutable bundle entries'
  [[ -z $invalid ]] || die 'bundle entries must have the required owner and no write bits'
  invalid=$(find "$bundle_source" -xdev ! \( -type f -o -type d -o -type l \) -print -quit) || die 'cannot validate bundle entry types'
  [[ -z $invalid ]] || die 'bundle contains an unsupported entry type'
  invalid=$(find "$bundle_source" -xdev -type l ! -uid "$owner" -print -quit) || die 'cannot validate bundle symlink ownership'
  [[ -z $invalid ]] || die 'bundle symlinks must have the required owner'
  while IFS= read -r -d '' link; do
    resolved=$(readlink -f "$link") || die 'bundle contains a broken symlink'
    [[ $resolved == "$bundle_source/"* ]] || die 'bundle symlink escapes its immutable release'
  done < <(find "$bundle_source" -xdev -type l -print0)
  adapter="$bundle_source/packages/adapter-sdk/dist/src/bin/$harness.js"
  [[ -f $adapter && ! -L $adapter && -x $adapter ]] || die 'bundle does not contain the assigned executable adapter'
  calculated=$(PYTHONDONTWRITEBYTECODE=1 python3 "$RUNTIME_HELPER_SOURCE" bundle-digest "$bundle_source") || die 'cannot calculate bundle digest'
  [[ $calculated == "${CONFIG[BUNDLE_SHA256]}" ]] || die 'configured bundle digest differs from immutable current release'
  bundle_digest=$calculated
}

validate_pki() {
  local pki=${CONFIG[PKI_DIR]} path name expected_openclaw=0
  assert_secure_directory "$pki" 'alias PKI directory'
  [[ ${CONFIG[OPENCLAW_TRANSPORT]:-cli} == api ]] && expected_openclaw=1
  shopt -s nullglob dotglob
  for path in "$pki"/*; do
    name=${path##*/}
    case "$name" in
      token|client.crt|client.key|ca.crt) ;;
      openclaw-token) (( expected_openclaw == 1 )) || die 'unexpected OpenClaw token file in PKI directory' ;;
      *) die 'alias PKI directory contains a non-allowlisted entry' ;;
    esac
    assert_secure_file "$path" 600 'alias PKI file'
  done
  shopt -u nullglob dotglob
  for name in client.crt client.key ca.crt; do [[ -f "$pki/$name" ]] || die "alias PKI file is missing: $name"; done
  [[ -f "$pki/token" ]] && bearer_token_present=true
  if (( expected_openclaw == 1 )); then [[ -f "$pki/openclaw-token" ]] || die 'OpenClaw API token file is missing'; fi
}

container_id=''
container_generation=''
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
  local before image label template mount_json after mount_args=()
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
  rm -f "$mount_json"
  valid_absolute_path "$discovered_mount_destination" || die 'discovered persistent mount is invalid' 75
  [[ $state_directory == "$discovered_mount_destination" || $state_directory == "${discovered_mount_destination%/}/"* ]] \
    || die 'discovered persistent mount does not contain the alias state directory' 75
  if [[ -v CONFIG[MOUNT_DESTINATION] ]]; then
    [[ ${CONFIG[MOUNT_DESTINATION]} == "$discovered_mount_destination" ]] || die 'declared MOUNT_DESTINATION differs from the discovered persistent mount'
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
  docker_id_mutate --user 0 ln -sfn "releases/$bundle_release" "$instance_root/current"
  active=$(docker_id_exec --user "$container_uid:$container_gid" /usr/bin/python3 "$control_helper" bundle-digest "$release")
  [[ $active == "$bundle_digest" ]] || die 'copied active bundle digest differs' 78
  adapter_in_container="$release/packages/adapter-sdk/dist/src/bin/$harness.js"
  active_bundle_in_container=$release
}

deploy_pki() {
  local pki=${CONFIG[PKI_DIR]} stage="/opt/cauce-v3-secrets/.stage-$alias_name-$container_generation-$$" name
  docker_id_mutate --user 0 rm -rf "$stage"
  docker_id_mutate --user 0 mkdir -p "$stage"
  docker_id_cp "$pki/." "$stage/"
  docker_id_mutate --user 0 chown -R "$container_uid:$container_gid" "$stage"
  docker_id_mutate --user 0 chmod 0700 "$stage"
  for name in client.crt client.key ca.crt; do docker_id_mutate --user 0 chmod 0600 "$stage/$name"; done
  if [[ $bearer_token_present == true ]]; then docker_id_mutate --user 0 chmod 0600 "$stage/token"; fi
  if [[ ${CONFIG[OPENCLAW_TRANSPORT]:-cli} == api ]]; then docker_id_mutate --user 0 chmod 0600 "$stage/openclaw-token"; fi
  docker_id_mutate --user 0 mkdir -p /opt/cauce-v3-secrets
  docker_id_mutate --user 0 chmod 0711 /opt/cauce-v3-secrets
  docker_id_mutate --user 0 rm -rf "$secret_directory"
  docker_id_mutate --user 0 mv "$stage" "$secret_directory"
}

start_adapter() {
  local lock_file runtime_path
  command -v docker >/dev/null 2>&1 || die 'docker is unavailable' 127
  command -v flock >/dev/null 2>&1 || die 'flock is unavailable' 127
  load_config
  validate_bundle
  if [[ ! -e $LOCK_ROOT ]]; then
    mkdir -p -- "$LOCK_ROOT" || die 'container adapter lock root cannot be created'
    chmod 0700 "$LOCK_ROOT" || die 'container adapter lock root cannot be secured'
  fi
  [[ -d $LOCK_ROOT && ! -L $LOCK_ROOT ]] || die 'container adapter lock root is unavailable'
  if (( EUID != 0 )) || [[ $LOCK_ROOT != /run/lock ]]; then
    assert_secure_directory "$LOCK_ROOT" 'container adapter lock root'
  fi
  lock_file="$LOCK_ROOT/cauce-v3-container-$alias_name.lock"
  exec 9>"$lock_file"
  flock -n 9 || die "another supervisor owns alias $alias_name" 73
  wait_for_container
  validate_container_identity_and_mount
  validate_pki
  resolve_container_identity
  copy_control_helper
  prepare_control_securely
  prepare_state_securely
  stop_existing
  deploy_bundle
  deploy_pki
  runtime_path="$container_home/.local/bin:$container_home/.npm-global/bin:$container_home/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  environment=(
    "HOME=$container_home" "USER=$container_user" "LOGNAME=$container_user" "PATH=$runtime_path"
    'LANG=C.UTF-8' 'LC_ALL=C.UTF-8' 'NODE_ENV=production' 'CAUCE_ENVIRONMENT=production'
    "CAUCE_TENANT=$tenant" "CAUCE_ROOM=$room" 'CAUCE_ORIGIN_TRANSPORT=telegram'
    "CAUCE_ALIAS=$alias_name" "CAUCE_INSTANCE_ID=systemd-container-$alias_name" "CAUCE_STATE_DIR=$state_directory"
    "CAUCE_CONTROL_DIR=$control_dir"
    "CAUCE_CONTAINER_ID=$container_id" "CAUCE_CONTAINER_GENERATION=$container_generation"
    "CAUCE_RELAY_URL=${CONFIG[RELAY_URL]}"
    "CAUCE_TLS_CERT_FILE=$secret_directory/client.crt" "CAUCE_TLS_KEY_FILE=$secret_directory/client.key" "CAUCE_TLS_CA_FILE=$secret_directory/ca.crt"
  )
  if [[ $bearer_token_present == true ]]; then environment+=("CAUCE_TOKEN_FILE=$secret_directory/token"); fi
  if [[ $harness == hermes ]]; then
    environment+=("HERMES_HOME=${CONFIG[HERMES_HOME]}" "HERMES_INFERENCE_MODEL=${CONFIG[HERMES_INFERENCE_MODEL]}")
    [[ -v CONFIG[HERMES_PYTHON] ]] && environment+=("CAUCE_HERMES_PYTHON=${CONFIG[HERMES_PYTHON]}")
  fi
  if [[ $harness == openclaw ]]; then
    environment+=("CAUCE_OPENCLAW_TRANSPORT=${CONFIG[OPENCLAW_TRANSPORT]:-cli}")
    [[ -v CONFIG[OPENCLAW_API_URL] ]] && environment+=("CAUCE_OPENCLAW_API_URL=${CONFIG[OPENCLAW_API_URL]}")
    [[ -v CONFIG[OPENCLAW_TOKEN_FILE] ]] && environment+=("CAUCE_OPENCLAW_TOKEN_FILE=${CONFIG[OPENCLAW_TOKEN_FILE]}")
    [[ -v CONFIG[OPENCLAW_AGENT_TARGET] ]] && environment+=("CAUCE_OPENCLAW_AGENT_TARGET=${CONFIG[OPENCLAW_AGENT_TARGET]}")
    [[ -v CONFIG[OPENCLAW_DIST_DIR] ]] && environment+=("CAUCE_OPENCLAW_DIST_DIR=${CONFIG[OPENCLAW_DIST_DIR]}")
  fi
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
  load_config
  validate_bundle
  wait_for_container
  validate_container_identity_and_mount
  resolve_container_identity
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
