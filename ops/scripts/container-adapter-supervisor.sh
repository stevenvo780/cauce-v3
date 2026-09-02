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
ALIAS_LOCK_EXEC="$ROOT/scripts/alias-lock-exec.py"
HERMES_RUNTIME_VERIFIER="$ROOT/scripts/verify-hermes-runtime.py"
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

# ---------------------------------------------------------------------------
# Per-alias configuration (CONFIG_POR_ALIAS switch, OFF by default).
#
# WHY. `kratos` and `atlas` run in the SAME container, with the same user and the same HOME
# (/home/dev). Their ~/.codex/AGENTS.md is the SAME INODE: it is physically impossible to give them
# distinct file-level identities. `zeus` and `argos` share CLAUDE.md for the same reason. That arrangement
# is the reason the role ended up in the database (020_agent_role_brief.sql).
#
# CLAUDE_CONFIG_DIR and CODEX_HOME already govern where each CLI looks, so pointing each alias at its own
# directory is the only thing needed to make the file useful again.
#
# The path is DERIVED from the alias and the mapped home; it is not a free-form config value. Whoever copies
# the files there is ops/scripts/separar-config-alias.mjs, and computes exactly the same. If they were two
# free values, one day one would copy to one directory and the other would read from another: the alias would
# boot with factory configuration and NOTHING would fail.
# ---------------------------------------------------------------------------

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
      CAUCE_NATIVE_PROFILE_CONTEXT) [[ $value =~ ^[01]$ ]] || die "CAUCE_NATIVE_PROFILE_CONTEXT must be exactly 0 or 1" ;;
      EXPECTED_CLI_VERSION) [[ $harness == claude ]] || die "config key is not allowed for $harness: $key" ;;
      HERMES_HOME|HERMES_INFERENCE_MODEL|HERMES_PYTHON|HERMES_SOURCE_COMMIT) [[ $harness == hermes ]] || die "config key is not allowed for $harness: $key" ;;
      # Shared session: the SAME conversation in owner's terminal and Telegram, only for claude/codex
      # (the two harnesses with a shareable TUI); elsewhere it would lie about which mode it runs in.
      SHARED_SESSION|SHARED_SESSION_WORKSPACE)
        [[ $harness == claude || $harness == codex ]] || die "config key is not allowed for $harness: $key"
        ;;
      # Per-alias configuration: only for the two harnesses that read a directory governed by a
      # variable. hermes reads stdin and openclaw does not read ~/.codex or ~/.claude; accepting
      # the key there would export a variable nobody reads and claim a separated alias.
      CONFIG_POR_ALIAS)
        [[ $harness == claude || $harness == codex ]] || die "config key is not allowed for $harness: $key"
        ;;
      OPENCLAW_TRANSPORT|OPENCLAW_API_URL|OPENCLAW_TOKEN_FILE|OPENCLAW_AGENT_TARGET|OPENCLAW_DIST_DIR|OPENCLAW_WORKSPACE)
        [[ $harness == openclaw ]] || die "config key is not allowed for $harness: $key"
        ;;
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
  local expected_pki="$PKI_ROOT/$alias_name" api_authority api_port default_timeout_ms
  local expected_hermes_home="$container_home/.local/share/cauce-v3/hermes/$alias_name"
  local expected_hermes_python approved_hermes_commit approved_hermes_line extra
  local approved_hermes_root approved_hermes_runtime_id
  local approved_hermes_version approved_uv_version approved_uv_target approved_uv_sha approved_uv_lock_sha
  local approved_uv_archive_url approved_uv_archive_sha
  valid_absolute_path "${CONFIG[PKI_DIR]}" || die 'PKI_DIR path is invalid'
  [[ ${CONFIG[BUNDLE_RELEASE]} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ \
    && ${CONFIG[BUNDLE_RELEASE]} != current ]] || die 'BUNDLE_RELEASE name is invalid'
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
  if [[ -v CONFIG[DEFAULT_TIMEOUT_MS] ]]; then
    [[ ${CONFIG[DEFAULT_TIMEOUT_MS]} =~ ^[0-9]{1,9}$ ]] \
      || die 'DEFAULT_TIMEOUT_MS must be a decimal integer between 60000 and 604800000'
    default_timeout_ms=$((10#${CONFIG[DEFAULT_TIMEOUT_MS]}))
    (( default_timeout_ms >= 60000 && default_timeout_ms <= 604800000 )) \
      || die 'DEFAULT_TIMEOUT_MS must be a decimal integer between 60000 and 604800000'
  fi
  # Only the exact value 1: accepted as "on" by one side and "off" by the other would give an alias
  # that thinks it shares and does not — precisely the state this work exists to eliminate.
  if [[ -v CONFIG[SHARED_SESSION] ]]; then
    [[ ${CONFIG[SHARED_SESSION]} == 1 ]] || die 'SHARED_SESSION must be exactly 1'
  fi
  if [[ -v CONFIG[SHARED_SESSION_WORKSPACE] ]]; then
    [[ -v CONFIG[SHARED_SESSION] ]] || die 'SHARED_SESSION_WORKSPACE requires SHARED_SESSION=1'
    valid_absolute_path "${CONFIG[SHARED_SESSION_WORKSPACE]}" || die 'SHARED_SESSION_WORKSPACE must be a canonical absolute path'
  fi
  # Both rewrite the same harness config directory live, racing the seeded profile against the owner.
  if [[ -v CONFIG[SHARED_SESSION] && ${CONFIG[CAUCE_NATIVE_PROFILE_CONTEXT]:-0} == 1 ]]; then
    die 'CAUCE_NATIVE_PROFILE_CONTEXT is incompatible with SHARED_SESSION'
  fi
  # By the same criterion as SHARED_SESSION: only the exact value 1. A `CONFIG_POR_ALIAS=true` read as
  # on by one side and off by another would leave the alias copying to one directory and reading from
  # another — exactly the state this work exists to eliminate.
  if [[ -v CONFIG[CONFIG_POR_ALIAS] ]]; then
    [[ ${CONFIG[CONFIG_POR_ALIAS]} == 1 ]] || die 'CONFIG_POR_ALIAS must be exactly 1'
    config_por_alias_directorio "$harness" "$container_home" "$alias_name" >/dev/null \
      || die 'CONFIG_POR_ALIAS cannot derive a per-alias configuration directory for this alias'
  fi
  [[ ${CONFIG[CAUCE_SEMBRAR_PERFIL]:-} == 1 ]] \
    || die 'CAUCE_SEMBRAR_PERFIL must be present and exactly 1'
  if [[ $harness == claude ]]; then
    [[ ${CONFIG[EXPECTED_CLI_VERSION]:-} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || die 'claude requires EXPECTED_CLI_VERSION as an exact semantic version'
  fi
  if (( physical_alias_count > 1 )); then
    if [[ $harness == claude || $harness == codex ]]; then
      [[ ${CONFIG[CONFIG_POR_ALIAS]:-} == 1 ]] \
        || die 'a multi-alias container requires CONFIG_POR_ALIAS=1 for claude/codex'
    elif [[ $harness == hermes ]]; then
      [[ ${CONFIG[HERMES_HOME]:-} == "$expected_hermes_home" ]] \
        || die 'a multi-alias container requires an alias-scoped HERMES_HOME'
    fi
  fi
  validate_relay_url "${CONFIG[RELAY_URL]}"
  if [[ $harness == hermes ]]; then
    [[ ${CONFIG[HERMES_SOURCE_COMMIT]:-} =~ ^[a-f0-9]{40}$ ]] \
      || die 'HERMES_SOURCE_COMMIT must be an exact lowercase Git commit'
    approved_hermes_line=$(python3 - "$ROOT/hermes-runtime.json" <<'PY'
import json, re, sys
try:
    document = json.load(open(sys.argv[1], encoding="utf-8"))
    commit = document["commit"]
    runtime_root = document["runtimeRoot"]
    runtime_id = document["runtimeId"]
    package_version = document["packageVersion"]
    uv_version = document["uvVersion"]
    uv_target = document["uvTarget"]
    uv_sha = document["uvSha256"]
    uv_lock_sha = document["uvLockSha256"]
    uv_archive_url = document["uvArchiveUrl"]
    uv_archive_sha = document["uvArchiveSha256"]
except Exception:
    sys.exit(1)
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
    sys.exit(1)
if runtime_root != "/opt/cauce-v3-hermes-runtime":
    sys.exit(1)
if not isinstance(runtime_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", runtime_id):
    sys.exit(1)
if not isinstance(package_version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", package_version):
    sys.exit(1)
if not isinstance(uv_version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", uv_version):
    sys.exit(1)
if not isinstance(uv_target, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", uv_target):
    sys.exit(1)
if not isinstance(uv_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", uv_sha):
    sys.exit(1)
if not isinstance(uv_lock_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", uv_lock_sha):
    sys.exit(1)
expected_url = f"https://github.com/astral-sh/uv/releases/download/{uv_version}/uv-{uv_target}.tar.gz"
if uv_archive_url != expected_url:
    sys.exit(1)
if not isinstance(uv_archive_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", uv_archive_sha):
    sys.exit(1)
print("\t".join((commit, runtime_root, runtime_id, package_version, uv_version, uv_target,
                 uv_sha, uv_lock_sha, uv_archive_url, uv_archive_sha)))
PY
    ) || die 'the approved Hermes runtime manifest is invalid'
    IFS=$'\t' read -r approved_hermes_commit approved_hermes_root approved_hermes_runtime_id \
      approved_hermes_version approved_uv_version approved_uv_target approved_uv_sha \
      approved_uv_lock_sha approved_uv_archive_url approved_uv_archive_sha extra \
      <<<"$approved_hermes_line"
    [[ -n $approved_hermes_commit && -n $approved_hermes_root && -n $approved_hermes_runtime_id \
      && -n $approved_hermes_version && -n $approved_uv_version && -n $approved_uv_target \
      && -n $approved_uv_sha && -n $approved_uv_lock_sha \
      && -n $approved_uv_archive_url && -n $approved_uv_archive_sha \
      && -z ${extra:-} ]] || die 'the approved Hermes runtime manifest is invalid'
    [[ ${CONFIG[HERMES_SOURCE_COMMIT]} == "$approved_hermes_commit" ]] \
      || die 'HERMES_SOURCE_COMMIT is not the approved operations pin'
    hermes_runtime_root=$approved_hermes_root
    hermes_runtime_id=$approved_hermes_runtime_id
    hermes_runtime_dir="$hermes_runtime_root/$alias_name/$hermes_runtime_id"
    hermes_source_dir="$hermes_runtime_dir/source"
    hermes_package_version=$approved_hermes_version
    hermes_uv_version=$approved_uv_version
    hermes_uv_target=$approved_uv_target
    hermes_uv_sha=$approved_uv_sha
    hermes_uv_lock_sha=$approved_uv_lock_sha
    hermes_uv_archive_url=$approved_uv_archive_url
    hermes_uv_archive_sha=$approved_uv_archive_sha
    expected_hermes_python="$hermes_runtime_dir/venv/bin/python"
    # The profile is mutable/persistent; executable code and its venv are an exact immutable
    # root-owned release under /opt. Accepting a user-home interpreter would reintroduce shared-UID
    # code injection between Atlas/Kratos/Iza.
    valid_absolute_path "${CONFIG[HERMES_HOME]:-}" || die 'HERMES_HOME must be a canonical absolute path'
    [[ ${CONFIG[HERMES_HOME]} == "$expected_hermes_home" ]] \
      || die 'HERMES_HOME must be the exact persistent alias profile path'
    [[ ${CONFIG[HERMES_INFERENCE_MODEL]:-} =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]] || die 'HERMES_INFERENCE_MODEL is invalid'
    valid_absolute_path "${CONFIG[HERMES_PYTHON]:-}" || die 'HERMES_PYTHON must be a canonical absolute path'
    [[ ${CONFIG[HERMES_PYTHON]} == "$expected_hermes_python" ]] \
      || die 'HERMES_PYTHON must be the exact immutable alias runtime interpreter'
  fi
  if [[ $harness == openclaw ]]; then
    valid_absolute_path "${CONFIG[OPENCLAW_WORKSPACE]:-}" \
      || die 'OPENCLAW_WORKSPACE must be a canonical absolute path'
    [[ ${CONFIG[OPENCLAW_WORKSPACE]} == "$inventory_workspace" ]] \
      || die 'OPENCLAW_WORKSPACE differs from the canonical inventory workspace'
    [[ ${CONFIG[OPENCLAW_WORKSPACE]} == "$container_home/"* ]] \
      || die 'OPENCLAW_WORKSPACE must live below the mapped container home'
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
  local owner mode numeric adapter invalid link resolved calculated
  [[ -x $RUNTIME_HELPER_SOURCE && -f $RUNTIME_HELPER_SOURCE ]] || die 'container runtime helper is unavailable'
  assert_secure_directory "$BUNDLE_ROOT" 'bundle root'
  assert_secure_directory "$BUNDLE_ROOT/releases" 'bundle releases directory'
  bundle_release=${CONFIG[BUNDLE_RELEASE]}
  bundle_source="$BUNDLE_ROOT/releases/$bundle_release"
  [[ -d $bundle_source && ! -L $bundle_source ]] || die 'BUNDLE_RELEASE must name one direct non-symlink release directory'
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
  [[ $calculated == "${CONFIG[BUNDLE_SHA256]}" ]] || die 'configured bundle digest differs from pinned immutable release'
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
  fi
  if [[ ${CONFIG[CONFIG_POR_ALIAS]:-} == 1 ]]; then
    runtime_path=$(config_por_alias_directorio "$harness" "$container_home" "$alias_name") \
      || { rm -f "$mount_json"; die 'cannot derive persistent alias configuration directory'; }
    runtime_paths+=("$runtime_path")
  fi
  # SHARED_SESSION always pins a workspace: undeclared gets the SDK's own default (config.ts).
  if [[ -v CONFIG[SHARED_SESSION] ]]; then
    shared_session_workspace=${CONFIG[SHARED_SESSION_WORKSPACE]:-/workspace}
    runtime_paths+=("$shared_session_workspace")
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

  # Probe only file types, ownership/mode and link destinations; never read a credential or print a
  # container-supplied path. The destination is its own regular inode; credential/config files stay
  # single-source symlinks so atomic login rotation is visible to every alias without copying bytes.
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
if harness == "codex":
    exact_link(required_one, os.path.join(source, required_one))
    exact_link(required_two, os.path.join(source, required_two))
else:
    exact_link(required_one, os.path.join(source, required_one))
    exact_link(required_two, os.path.join(os.path.dirname(source), required_two))
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
  local runtime_path effective_default_timeout_ms
  command -v docker >/dev/null 2>&1 || die 'docker is unavailable' 127
  [[ -f $ALIAS_LOCK_EXEC && ! -L $ALIAS_LOCK_EXEC ]] || die 'alias lock helper is unavailable' 73
  if [[ -z ${CAUCE_ALIAS_LOCK_FD:-} ]]; then
    exec env CAUCE_CONTAINER_OPS_ROOT="$ROOT" CAUCE_CONTAINER_LOCK_ROOT="$LOCK_ROOT" \
      python3 "$ALIAS_LOCK_EXEC" run --lock-root "$LOCK_ROOT" --alias "$alias_name" -- \
      "$0" start "$alias_name"
  fi
  python3 "$ALIAS_LOCK_EXEC" verify --lock-root "$LOCK_ROOT" --alias "$alias_name" \
    || die "another supervisor owns alias $alias_name" 73
  load_config
  validate_bundle
  wait_for_container
  validate_container_identity_and_mount
  validate_pki
  resolve_container_identity
  ensure_isolated_config
  ensure_claude_binary
  ensure_hermes_runtime
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
    "CAUCE_TLS_CERT_FILE=$secret_directory/client.crt" "CAUCE_TLS_KEY_FILE=$secret_directory/client.key" "CAUCE_TLS_CA_FILE=$secret_directory/ca.crt"
  )
  environment+=("CAUCE_SEMBRAR_PERFIL=${CONFIG[CAUCE_SEMBRAR_PERFIL]}")
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
  if [[ -v CONFIG[SHARED_SESSION] ]]; then
    environment+=("CAUCE_SHARED_SESSION=${CONFIG[SHARED_SESSION]}")
    [[ -v CONFIG[SHARED_SESSION_WORKSPACE] ]] \
      && environment+=("CAUCE_SHARED_SESSION_WORKSPACE=${CONFIG[SHARED_SESSION_WORKSPACE]}")
    # tmux creates the session with this TERM. Without it the server is born with an unknown terminal
    # and the TUI renders broken for the owner, who is the one who joins afterwards.
    environment+=('TERM=xterm-256color')
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
  if [[ $harness == openclaw ]]; then
    environment+=("CAUCE_OPENCLAW_WORKSPACE=${CONFIG[OPENCLAW_WORKSPACE]}")
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
  validate_pki
  resolve_container_identity
  ensure_isolated_config
  ensure_claude_binary
  ensure_hermes_runtime
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
