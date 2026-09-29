# Sourced by container-adapter-supervisor.sh: config, bundle and PKI validation.
# Not standalone: it runs in the supervisor shell and uses its state (die, CONFIG, paths).

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
  local expected_pki="$PKI_ROOT/$alias_name" api_authority api_port default_timeout_ms key
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
  [[ ! -v CONFIG[SHARED_SESSION_NATIVE_ID] || -v CONFIG[SHARED_SESSION] ]] || die 'SHARED_SESSION_NATIVE_ID requires SHARED_SESSION=1'
  [[ ! -v CONFIG[SHARED_SESSION_NATIVE_ID] || ${CONFIG[SHARED_SESSION_NATIVE_ID]} =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || die 'SHARED_SESSION_NATIVE_ID must be a canonical lowercase UUID'
  # Both rewrite the same harness config directory live, racing the seeded profile against the owner.
  if [[ -v CONFIG[SHARED_SESSION] && ${CONFIG[CAUCE_NATIVE_PROFILE_CONTEXT]:-0} == 1 ]]; then
    die 'CAUCE_NATIVE_PROFILE_CONTEXT is incompatible with SHARED_SESSION'
  fi
  [[ ${CONFIG[CAUCE_NATIVE_PROFILE_CONTEXT]:-0} != 1 || $harness == claude || $harness == openclaw ]] \
    || die 'CAUCE_NATIVE_PROFILE_CONTEXT requires the claude or openclaw harness'
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
  if [[ $harness == muse && -z $inventory_workspace ]]; then
    # The muse-cauce bridge (no inventory workspace) reads none of the workspace-agent keys.
    for key in MUSE_EXECUTABLE MUSE_CONFIG_HOME MUSE_DATA_HOME MUSE_WORKSPACE MUSE_MODEL MUSE_REASONING_EFFORT MUSE_APPROVAL_MODE MUSE_YOLO; do
      [[ ! -v "CONFIG[$key]" ]] || die "$key requires a muse workspace in the inventory"
    done
  elif [[ $harness == muse ]]; then
    [[ ${CONFIG[MUSE_EXECUTABLE]:-} == /opt/muse-code/muse ]] || die 'MUSE_EXECUTABLE must use the pinned Muse mount'
    [[ ${CONFIG[MUSE_CONFIG_HOME]:-} == "$container_home/.muse/config" ]] || die 'MUSE_CONFIG_HOME must use the isolated persistent profile'
    [[ ${CONFIG[MUSE_DATA_HOME]:-} == "$container_home/.muse/data" ]] || die 'MUSE_DATA_HOME must use the isolated persistent profile'
    [[ ${CONFIG[MUSE_WORKSPACE]:-} == "$inventory_workspace" ]] || die 'MUSE_WORKSPACE differs from the canonical inventory workspace'
    [[ ${CONFIG[MUSE_APPROVAL_MODE]:-} =~ ^(denyUnmatched|onRequest|allowAll)$ ]] || die 'MUSE_APPROVAL_MODE is invalid'
    [[ ( ${CONFIG[MUSE_APPROVAL_MODE]} == allowAll && ${CONFIG[MUSE_YOLO]:-} == 1 ) || ( ${CONFIG[MUSE_APPROVAL_MODE]} != allowAll && ! -v CONFIG[MUSE_YOLO] ) ]] || die 'Muse YOLO and allowAll must be configured together'
    [[ ! -v CONFIG[MUSE_MODEL] || ${CONFIG[MUSE_MODEL]} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die 'MUSE_MODEL is invalid'
    [[ ! -v CONFIG[MUSE_REASONING_EFFORT] || ${CONFIG[MUSE_REASONING_EFFORT]} =~ ^(none|minimal|low|medium|high|xhigh|max|ultra)$ ]] || die 'MUSE_REASONING_EFFORT is invalid'
  fi
}

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
  [[ $harness == openclaw && ${CONFIG[OPENCLAW_TRANSPORT]:-cli} == api ]] && expected_openclaw=1
  shopt -s nullglob dotglob
  for path in "$pki"/*; do
    name=${path##*/}
    case "$name" in
      token|client.crt|client.key|ca.crt) ;;
      # A muse alias migrated from openclaw may keep the old token; deploy_pki never copies it.
      openclaw-token) (( expected_openclaw == 1 )) || [[ $harness == muse ]] || die 'unexpected OpenClaw token file in PKI directory' ;;
      *) die 'alias PKI directory contains a non-allowlisted entry' ;;
    esac
    assert_secure_file "$path" 600 'alias PKI file'
  done
  shopt -u nullglob dotglob
  for name in client.crt client.key ca.crt; do [[ -f "$pki/$name" ]] || die "alias PKI file is missing: $name"; done
  [[ -f "$pki/token" ]] && bearer_token_present=true
  if (( expected_openclaw == 1 )); then [[ -f "$pki/openclaw-token" ]] || die 'OpenClaw API token file is missing'; fi
}
