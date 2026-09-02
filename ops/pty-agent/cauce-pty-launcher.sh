#!/usr/bin/env bash
set -euo pipefail
umask 077

# Publishes the PTY agent and its bundle inside the target container, then execs the agent
# as the mapped runtime UID. Never opens a listening socket: the agent dials OUT to the relay.

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

# Transient failure: exit 75 (EX_TEMPFAIL), which is NOT in the unit's
# RestartPreventExitStatus=2 78. Separated from `die` because the two failures are distinct:
# a missing release artifact (redeployable) must not stop the 15 PTY units forever the way a
# permanent configuration error (caught by `die`) would.
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
valid_absolute_path "$state_directory" || die 'mapped state directory is invalid'

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
      RELAY_HOST|RELAY_PORT|RELAY_SERVER_NAME|PKI_DIR|ALIAS_KEY_FILE|HARNESS_COMMAND|SHELL_CANDIDATES|OPENCLAW_DIST_DIR) ;;
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
  if [[ -v 'CONFIG[OPENCLAW_DIST_DIR]' ]]; then
    valid_absolute_path "${CONFIG[OPENCLAW_DIST_DIR]}" || die 'OPENCLAW_DIST_DIR path is invalid'
    [[ ${CONFIG[OPENCLAW_DIST_DIR]} == "$container_home/"* ]] \
      || die 'OPENCLAW_DIST_DIR must live below the mapped container home'
  fi
}

validate_channel_material() {
  local pki=${CONFIG[PKI_DIR]} name
  assert_secure_directory "$pki" 'PTY alias PKI directory'
  for name in client.crt client.key ca.crt; do
    assert_secure_file "$pki/$name" 600 "PTY channel material ($name)"
  done
# The derived alias key is the agent's second, independent ticket check. Per-alias, so it
# cannot authorise any other agent even if the manager is fully compromised.
  assert_secure_file "${CONFIG[ALIAS_KEY_FILE]}" 400 'PTY alias key'
  [[ $(stat -c '%s' "${CONFIG[ALIAS_KEY_FILE]}") -ge 64 ]] || die 'PTY alias key file is too short to hold 32 bytes of hex'
}

container_id=''
container_image=''
container_generation=''
container_started=''
container_restart=''

read_generation() {
  local output id image started restart running extra digest
  output=$(docker_control inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Running}}' "$container_name" 2>/dev/null) \
    || die "container is not inspectable for alias $alias_name" 1
  read -r id image started restart running extra <<<"$output"
  [[ $id =~ ^[a-f0-9]{64}$ ]] || die 'container id is invalid' 75
  [[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || die 'container image id is invalid' 75
  [[ $started =~ ^[0-9T:.+-]+Z?$ && $restart =~ ^[0-9]+$ && -z ${extra:-} ]] || die 'container state signature is invalid' 75
  [[ $running == true ]] || die "container is not running for alias $alias_name" 1
  # The generation binds this launch to one container incarnation: the gateway-signed ticket
  # names it, so a restart between issue and use invalidates every outstanding ticket.
  digest=$(printf '%s|%s|%s' "$id" "$started" "$restart" | sha256sum)
  digest=${digest%% *}
  [[ $digest =~ ^[a-f0-9]{64}$ ]] || die 'container generation digest is invalid' 75
  container_id=$id
  container_image=$image
  container_generation=${digest:0:32}
  container_started=$started
  container_restart=$restart
}

# The supervisor stamps CAUCE_CONTAINER_GENERATION with ITS formula (NUL-joined, four fields with the
# container init start time, full digest); the measurement matches the adapter by that exact value.
# Reusing this launcher's own 32-char ticket generation never matched, so every measurement came back
# empty and profile writes answered 503 for every alias. Both are kept: the ticket one is protocol.
adapter_generation=''
read_adapter_generation() {
  local init_starttime digest
  init_starttime=$(docker_control exec "$container_id" /usr/bin/python3 -c \
    'raw=open("/proc/1/stat",encoding="utf-8").read(); fields=raw[raw.rfind(")")+2:].split(); print(fields[19])' 2>/dev/null) || return 1
  [[ $init_starttime =~ ^[0-9]+$ ]] || return 1
  digest=$(printf '%s\0%s\0%s\0%s' "$container_id" "$container_started" "$container_restart" "$init_starttime" | sha256sum)
  digest=${digest%% *}
  [[ $digest =~ ^[a-f0-9]{64}$ ]] || return 1
  adapter_generation=$digest
}

runtime_uid=''
runtime_gid=''

resolve_runtime_identity() {
  runtime_uid=$(docker_control exec "$container_id" id -u "$container_user") || die 'mapped container user is unavailable' 1
  runtime_gid=$(docker_control exec "$container_id" id -g "$container_user") || die 'mapped container group is unavailable' 1
  runtime_uid=${runtime_uid//[$'\r\n']/}
  runtime_gid=${runtime_gid//[$'\r\n']/}
  [[ $runtime_uid =~ ^[0-9]+$ && $runtime_gid =~ ^[0-9]+$ ]] || die 'container runtime identity is invalid' 1
  # Fail-closed exit reserved for identity violations: a root identity would collapse the boundary.
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
  # Root-owned and non-writable inside the container: the runtime user executes but cannot rewrite.
  docker_control cp "$AGENT_SOURCE" "$container_id:$agent_path" || die 'cannot publish the PTY agent'
  docker_control exec --user 0 "$container_id" chown 0:0 "$agent_path" || die 'cannot own the published PTY agent'
  docker_control exec --user 0 "$container_id" chmod 0555 "$agent_path" || die 'cannot secure the published PTY agent'
}

# Fleet tmux socket. Not the default: plain `tmux ls` does not see these sessions.
TMUX_SOCKET=${CAUCE_PTY_TMUX_SOCKET:-cauce}

# `harness` mode emits the TUI for an already-running agent; `shell` opens a new terminal.
# When HARNESS_COMMAND is unset, the tmux binary is discovered inside the container as the
# agent user (socket is per-uid). The bundle stores path+socket even if no session exists yet:
# the agent validates name, markers, and panel atomically on every OPEN, so a tmux appearing
# later becomes available without restarting the unit. The initial probe only measures the
# cwd of an already-validated panel and never freezes the target.
#
#   -r              READ-ONLY client: console cannot type into someone else's TUI.
#   -f ignore-size  browser size does not renegotiate session size; viewing does not shrink
#                   the panel for the human working in that same tmux.
derive_harness_command() {
  local tmux_path session windows observed_session_name observed_session_id extra session_id
  local validated_pane_cwd
  local marker_alias marker_harness window_name window_panes tui_windows pane_pid pane_dead pane_cwd
  TMUX_MEASUREMENT_CONFLICT=0
  TMUX_PANE_CWD_FOUND=''
  tmux_path=$(docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
    sh -c 'command -v tmux' 2>/dev/null) || return 1
  [[ $tmux_path != *$'\r'* && $tmux_path != *$'\n'* ]] || return 1
  [[ -n $tmux_path ]] || return 1
  valid_absolute_path "$tmux_path" || return 1
  # The executable is the image's stable capability: kept even when no server/session exists yet;
  # the agent additionally validates ownership/mode and resolves the session per OPEN.
  TMUX_PATH_FOUND=$tmux_path
  session="cauce-$alias_name"

  # One tmux command returns session, markers, window cardinality and pane facts from the same
  # observation: five independent probes could otherwise assemble a cwd from states that never
  # coexisted. `list-windows` also lets us reject duplicate `tui` windows explicitly.
  windows=$(docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
    "$tmux_path" -L "$TMUX_SOCKET" list-windows -t "$session" -F \
    $'#{session_name}\t#{session_id}\t#{window_name}\t#{window_panes}\t#{@cauce_alias}\t#{@cauce_harness}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_path}' \
    2>/dev/null) || return 1
  [[ $windows != *$'\r'* ]] || return 1
  # From here a session claims the alias name: if any marker/pane fails, do NOT degrade to an
  # invented root; the caller distinguishes the clash.
  TMUX_MEASUREMENT_CONFLICT=1
  session_id=''
  validated_pane_cwd=''
  tui_windows=0
  while IFS=$'\t' read -r observed_session_name observed_session_id window_name window_panes \
    marker_alias marker_harness pane_pid pane_dead pane_cwd extra; do
    [[ -z ${extra:-} && $observed_session_name == "$session" \
      && $observed_session_id =~ ^\$[0-9]+$ ]] || return 1
    [[ $window_name == tui ]] || continue
    tui_windows=$((tui_windows + 1))
    [[ $window_panes == 1 && $marker_alias == "$alias_name" && $marker_harness == "$harness" \
      && $pane_pid =~ ^[1-9][0-9]*$ && $pane_dead == 0 ]] || return 1
    valid_absolute_path "$pane_cwd" || return 1
    session_id=$observed_session_id
    validated_pane_cwd=$pane_cwd
  done <<<"$windows"
  [[ $tui_windows -eq 1 && -n $session_id ]] || return 1

  TMUX_SESSION_FOUND=$session_id
  TMUX_TARGET_FOUND="${session_id}:tui"
  TMUX_PANE_CWD_FOUND=$validated_pane_cwd
  TMUX_MEASUREMENT_CONFLICT=0
  return 0
}

# Real OpenClaw entry inside the container, and where it stores its conversations.
# Invoke the entry, not the `openclaw` wrapper: the wrapper re-execs and leaves its argv as
# bare `openclaw`, which the gateway supervisor also avoids; an unrecognisable argv cannot be
# supervised or audited.
OPENCLAW_HISTORY_LIMIT=${CAUCE_PTY_OPENCLAW_HISTORY_LIMIT:-200}
[[ $OPENCLAW_HISTORY_LIMIT =~ ^[0-9]{1,5}$ && $((10#$OPENCLAW_HISTORY_LIMIT)) -ge 1 \
  && $((10#$OPENCLAW_HISTORY_LIMIT)) -le 10000 ]] || die 'OpenClaw history limit is invalid'

# Native OpenClaw TUI for aliases that do not (and cannot) have a tmux panel.
# The panel emitted by 7 aliases today is the SHARED SESSION, which exists only for `claude` and
# `codex`. An `openclaw` alias does not start `cauce-<alias>` in tmux, and its images may not even
# ship tmux: its process is a daemon (`node .../openclaw/dist/index.js gateway`), not a screen.
# Hence `derive_harness_command` returns empty and the console says "no TUI to emit".
# OpenClaw DOES bring its own TUI, a client of the gateway that the same alias already runs on
# loopback. So no tmux, no new image, no extra supervised process: launch it in the agent's pty
# like any other `harness_command`.
# The read-only lock is NOT here (no `tmux -r` equivalent); the PTY agent enforces it via a viewer
# mode that rejects human STDIN and only forwards the closed list of DA/DSR technical replies.
# Capability is measured INSIDE the container as the alias user. Presence only advertises
# `harness` when the canonical pointer exists, is initialised, and passes the same
# ownership/mode/schema boundary the agent re-checks on every OPEN. The native id never leaves
# that process nor is frozen in the bundle.
validate_openclaw_tui_pointer() {
  docker_control exec -i --user "$runtime_uid:$runtime_gid" \
    --env "CAUCE_PTY_OPENCLAW_POINTER_ALIAS=$alias_name" \
    --env "CAUCE_PTY_OPENCLAW_POINTER_STATE=$state_directory" \
    "$container_id" /usr/bin/python3 - <<'PYTHON'
import json
import os
import re
import stat

alias = os.environ["CAUCE_PTY_OPENCLAW_POINTER_ALIAS"]
state_directory = os.environ["CAUCE_PTY_OPENCLAW_POINTER_STATE"]
native_id_pattern = re.compile(r"^[A-Za-z0-9._:-]{1,512}$")


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


try:
    directory = os.lstat(state_directory)
    if (not stat.S_ISDIR(directory.st_mode)
            or directory.st_uid != os.geteuid()
            or directory.st_mode & 0o022
            or os.path.realpath(state_directory) != state_directory):
        raise SystemExit(1)
    path = os.path.join(state_directory, "sessions.json")
    flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(path, flags)
    try:
        details = os.fstat(descriptor)
        if (not stat.S_ISREG(details.st_mode)
                or details.st_uid != os.geteuid()
                or details.st_mode & 0o777 != 0o600
                or details.st_nlink != 1
                or details.st_size > 1024 * 1024):
            raise SystemExit(1)
        raw = bytearray()
        while len(raw) <= 1024 * 1024:
            chunk = os.read(descriptor, min(65536, 1024 * 1024 + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        if len(raw) > 1024 * 1024:
            raise SystemExit(1)
    finally:
        os.close(descriptor)
    document = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=reject_duplicates)
except (OSError, UnicodeError, ValueError):
    raise SystemExit(1)

if (not isinstance(document, dict)
        or set(document) != {"version", "sessions"}
        or document.get("version") != 1
        or not isinstance(document.get("sessions"), dict)
        or len(document["sessions"]) > 4096):
    raise SystemExit(1)

# An exact key, derived locally. The object_pairs_hook above prevents two pointers with the same
# name from surviving the parser by silently picking the last one.
pointer = document["sessions"].get(f"openclaw:{alias}:shared:{alias}")
if (not isinstance(pointer, dict)
        or set(pointer) not in ({"native_id", "initialized"}, {"native_id", "initialized", "origin"})
        or pointer.get("initialized") is not True
        or not isinstance(pointer.get("native_id"), str)
        or native_id_pattern.fullmatch(pointer["native_id"]) is None):
    raise SystemExit(1)
PYTHON
}

derive_openclaw_tui_command() {
  local node_path tui_help entry configured_dist
  local -a entry_candidates=()
  node_path=$(docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
    sh -c 'command -v node' 2>/dev/null) || return 1
  node_path=${node_path//[$'\r\n']/}
  valid_absolute_path "$node_path" || return 1
  # Detecting the binary is not enough: a TUI without a resolvable conversation is a false capability.
  validate_openclaw_tui_pointer >/dev/null 2>&1 || return 1

  configured_dist=${CONFIG[OPENCLAW_DIST_DIR]:-}
  if [[ -n $configured_dist ]]; then
    entry_candidates+=("${configured_dist%/}/index.js")
  else
    # The canonical fleet install is user-local. The global one is measured compatibility for
    # older containers; never walk PATH or the filesystem looking for candidates.
    entry_candidates+=(
      "${container_home%/}/.openclaw/node_modules/openclaw/dist/index.js"
      "/usr/lib/node_modules/openclaw/dist/index.js"
    )
  fi

  for entry in "${entry_candidates[@]}"; do
    docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
      test -f "$entry" >/dev/null 2>&1 || continue

    # Ask the INSTALLED binary whether it has the TUI and accepts `--session`. openclaw updates
    # itself, so nobody's memory is authoritative: when the subcommand or flag changes, this
    # stops advertising the TUI instead of advertising an empty screen.
    tui_help=$(docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" \
      "$node_path" "$entry" tui --help 2>/dev/null) || continue
    [[ $tui_help == *"--session"* ]] || continue
    OPENCLAW_ENTRY=$entry
    OPENCLAW_NODE_FOUND=$node_path
    return 0
  done

  return 1
}

# Read only non-secret path facts from the adapter actually running for this alias/generation.
# `cwd` comes from `/proc/<pid>/cwd`, never from the launcher's PWD or the browser.
# `workspace_root` is published only when that same adapter explicitly carries
# `CAUCE_SHARED_SESSION_WORKSPACE`; inside that bounded root the nearest real `.git` marker
# accredits `project_root`. Without a workspace root, cwd authorises exactly one project level.
#
# The scan runs as the runtime uid and never prints the rest of `/proc/*/environ`. Every matching
# process must agree byte-for-byte. Absence, ambiguity, or an unsafe path yields `{}`: runtime
# facts are optional evidence and must never stop the shell/PTY transport. A half-measured fact
# is worse than no project context because shared containers and shared HOME directories make
# plausible-looking sibling paths exist.
measure_adapter_runtime_facts() {
  local measured
  local -a measurement_environment=(
    --env "CAUCE_PTY_MEASURE_ALIAS=$alias_name"
    --env "CAUCE_PTY_MEASURE_GENERATION=$adapter_generation"
    --env "CAUCE_PTY_MEASURE_STATE=$state_directory"
    --env "CAUCE_PTY_MEASURE_HOME=$container_home"
    --env "CAUCE_PTY_MEASURE_HARNESS=$harness"
  )
  [[ -z ${TMUX_PANE_CWD_FOUND:-} ]] \
    || measurement_environment+=(--env "CAUCE_PTY_MEASURE_TMUX_CWD=$TMUX_PANE_CWD_FOUND")
  if ! measured=$(docker_control exec -i --user "$runtime_uid:$runtime_gid" \
    "${measurement_environment[@]}" \
    "$container_id" /usr/bin/python3 - <<'PYTHON'
import json
import os
import stat
try:
    import tomllib
except ImportError:  # El PTY sigue vivo; el gateway marcará la cobertura como parcial.
    tomllib = None

identity = {
    "CAUCE_ALIAS": os.environ["CAUCE_PTY_MEASURE_ALIAS"],
    "CAUCE_CONTAINER_GENERATION": os.environ["CAUCE_PTY_MEASURE_GENERATION"],
    "CAUCE_STATE_DIR": os.environ["CAUCE_PTY_MEASURE_STATE"],
}
home = os.path.normpath(os.environ["CAUCE_PTY_MEASURE_HOME"])
harness = os.environ["CAUCE_PTY_MEASURE_HARNESS"]
tmux_cwd = os.environ.get("CAUCE_PTY_MEASURE_TMUX_CWD", "")
wire_for_harness = {
    "codex": ("CODEX_HOME", "codex_home"),
    "claude": ("CLAUDE_CONFIG_DIR", "claude_config_dir"),
    "openclaw": ("CAUCE_OPENCLAW_WORKSPACE", "openclaw_workspace"),
}.get(harness)
observed = set()
for name in os.listdir("/proc"):
    if not name.isdigit() or int(name) == os.getpid():
        continue
    try:
        raw = open(f"/proc/{name}/environ", "rb").read()
        environment = {}
        for item in raw.split(b"\0"):
            if b"=" not in item:
                continue
            key, value = item.split(b"=", 1)
            environment[key.decode("utf-8", "strict")] = value.decode("utf-8", "strict")
    except (OSError, UnicodeError):
        continue
    if any(environment.get(key) != value for key, value in identity.items()):
        continue
    if environment.get("HOME") != home:
        continue
    try:
        cwd = os.readlink(f"/proc/{name}/cwd")
    except OSError:
        continue
    profile = "" if wire_for_harness is None else environment.get(wire_for_harness[0], "")
    workspace_root = environment.get("CAUCE_SHARED_SESSION_WORKSPACE", "")
    observed.add((profile, cwd, workspace_root))

def safe_directory(path, *, below_home=False):
    try:
        details = os.lstat(path)
        safe = (path.startswith("/") and path != "/" and os.path.normpath(path) == path
                and stat.S_ISDIR(details.st_mode) and not stat.S_ISLNK(details.st_mode)
                and os.path.realpath(path) == path)
        if below_home:
            safe = safe and os.path.commonpath((home, path)) == home \
                and details.st_uid == os.geteuid()
        return safe
    except (OSError, ValueError):
        return False

def project_root_within(workspace_root, cwd):
    current = cwd
    for _ in range(65):
        marker = f"{current.rstrip('/')}/.git"
        try:
            details = os.lstat(marker)
        except FileNotFoundError:
            pass
        except OSError:
            raise SystemExit(2)
        else:
            if stat.S_ISLNK(details.st_mode) or not (
                    stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode)) \
                    or os.path.realpath(marker) != marker:
                raise SystemExit(2)
            return current
        if current == workspace_root:
            break
        parent = os.path.dirname(current)
        if parent == current or not (parent == workspace_root or parent.startswith(workspace_root + "/")):
            raise SystemExit(2)
        current = parent
    return cwd

unsafe_text_code_point_ranges = (
    (0x00, 0x1f), (0x7f, 0x9f), (0x61c, 0x61c), (0x200b, 0x200f),
    (0x2028, 0x202e), (0x2060, 0x206f), (0xfeff, 0xfeff), (0xfff9, 0xfffb),
)

def codex_instruction_config(codex_home):
    config_path = f"{codex_home.rstrip('/')}/config.toml"
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(config_path, flags)
    except FileNotFoundError:
        return 32768, []
    except OSError:
        return None
    try:
        details = os.fstat(descriptor)
        if (not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid()
                or details.st_nlink != 1 or details.st_size > 1024 * 1024 or tomllib is None):
            return None
        raw = bytearray()
        while len(raw) <= 1024 * 1024:
            chunk = os.read(descriptor, min(65536, 1024 * 1024 + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        if len(raw) > 1024 * 1024:
            return None
    finally:
        os.close(descriptor)
    try:
        parsed = tomllib.loads(bytes(raw).decode("utf-8"))
    except (UnicodeError, ValueError):
        return None
    maximum = parsed.get("project_doc_max_bytes", 32768)
    fallbacks = parsed.get("project_doc_fallback_filenames", [])
    if (not isinstance(maximum, int) or isinstance(maximum, bool)
            or maximum < 1 or maximum > 16 * 1024 * 1024
            or not isinstance(fallbacks, list) or len(fallbacks) > 16):
        return None
    safe = []
    seen = {"agents.override.md", "agents.md"}
    forbidden = {".credentials.json", "auth.json", ".claude.json", "openclaw.json", ".env",
                 ".netrc", "id_ed25519", "id_rsa", "known_hosts", "authorized_keys"}
    for name in fallbacks:
        try:
            js_length = len(name.encode("utf-16-le")) // 2 if isinstance(name, str) else 0
        except UnicodeEncodeError:
            return None
        normalized = name.casefold() if isinstance(name, str) else ""
        if (not isinstance(name, str) or not name or js_length > 128 or normalized in seen
                or "/" in name or "\\" in name or "\0" in name or ".." in name
                or any(lower <= ord(character) <= upper for character in name
                       for lower, upper in unsafe_text_code_point_ranges)
                or normalized in forbidden
                or normalized.endswith((".pem", ".key", ".p12", ".pfx"))):
            return None
        seen.add(normalized)
        safe.append(name)
    return maximum, safe

if len(observed) != 1:
    raise SystemExit(2)

profile, process_cwd, workspace_root = next(iter(observed))

document = {}
if wire_for_harness is not None:
    if not safe_directory(profile, below_home=True):
        raise SystemExit(2)
    document[wire_for_harness[1]] = profile
    if harness == "codex":
        instruction_config = codex_instruction_config(profile)
        if instruction_config is not None:
            document["project_doc_max_bytes"] = instruction_config[0]
            document["project_doc_fallback_filenames"] = instruction_config[1]
if workspace_root:
    cwd = tmux_cwd or process_cwd
    try:
        contains_cwd = os.path.commonpath((workspace_root, cwd)) == workspace_root
    except ValueError:
        contains_cwd = False
    if not safe_directory(workspace_root):
        raise SystemExit(2)
    if safe_directory(cwd) and contains_cwd:
        document["cwd"] = cwd
        document["workspace_root"] = workspace_root
        document["project_root"] = project_root_within(workspace_root, cwd)
    elif tmux_cwd:
        # A pane cwd is accepted only after the complete alias/harness/panel identity check. If
        # that accredited value is outside the declared workspace, discard every fact.
        raise SystemExit(2)
    # The adapter process may legitimately run outside the shared workspace. Without a validated
    # pane there is no project cwd to publish; retain only the independently measured profile fact.
else:
    if tmux_cwd or not safe_directory(process_cwd):
        raise SystemExit(2)
    document["cwd"] = process_cwd
    document["project_root"] = process_cwd
print(json.dumps(document, separators=(",", ":")))
PYTHON
  ); then
    printf 'cauce-pty-launcher: runtime facts unavailable alias=%s; publishing empty facts\n' \
      "$alias_name" >&2
    printf '{}'
    return 0
  fi
  if [[ $measured != \{*\} ]]; then
    printf 'cauce-pty-launcher: runtime facts malformed alias=%s; publishing empty facts\n' \
      "$alias_name" >&2
    printf '{}'
    return 0
  fi
  printf '%s' "$measured"
}

publish_bundle() {
  local shell_candidates harness_command tmux_tui openclaw_tui runtime_facts
  shell_candidates=${CONFIG[SHELL_CANDIDATES]:-'[["/bin/bash","-l"],["/bin/sh","-l"]]'}
  harness_command=${CONFIG[HARNESS_COMMAND]:-}
  tmux_tui=null
  openclaw_tui=null
  TMUX_PANE_CWD_FOUND=''
  TMUX_MEASUREMENT_CONFLICT=0
  if [[ -z $harness_command ]]; then
    TMUX_PATH_FOUND=''
    TMUX_SESSION_FOUND=''
    # shellcheck disable=SC2034  # contract: the PTY suite reads this variable
    TMUX_TARGET_FOUND=''
    if [[ $harness == codex || $harness == claude ]]; then
      if derive_harness_command; then
        printf 'cauce-pty-launcher: live tmux context measured alias=%s socket=%s measured_session_id=%s\n' \
          "$alias_name" "$TMUX_SOCKET" "$TMUX_SESSION_FOUND" >&2
      elif [[ -n $TMUX_PATH_FOUND ]]; then
        if [[ $TMUX_MEASUREMENT_CONFLICT -eq 1 ]]; then
          printf 'cauce-pty-launcher: tmux context not accredited alias=%s socket=%s; OPEN will revalidate\n' \
            "$alias_name" "$TMUX_SOCKET" >&2
        else
          printf 'cauce-pty-launcher: no live tmux session yet alias=%s socket=%s; OPEN will discover it\n' \
            "$alias_name" "$TMUX_SOCKET" >&2
        fi
      fi
    fi
    if [[ -n $TMUX_PATH_FOUND ]]; then
      harness_command=null
      tmux_tui=$(CAUCE_TMUX_PATH=$TMUX_PATH_FOUND CAUCE_TMUX_SOCKET=$TMUX_SOCKET \
        PYTHONDONTWRITEBYTECODE=1 python3 -c \
        'import json,os;print(json.dumps({"path":os.environ["CAUCE_TMUX_PATH"],"socket":os.environ["CAUCE_TMUX_SOCKET"]},separators=(",",":")))') \
        || die "cannot assemble the dynamic tmux harness resolver"
      printf 'cauce-pty-launcher: dynamic tmux resolver enabled alias=%s socket=%s\n' \
        "$alias_name" "$TMUX_SOCKET" >&2
    else
      # Without a tmux panel, try the native OpenClaw TUI. Order matters and cannot be inverted:
      # an alias with a shared session must keep emitting the panel its owner is watching.
      OPENCLAW_NODE_FOUND=''
      if [[ $harness == openclaw ]] && derive_openclaw_tui_command; then
        harness_command=null
        openclaw_tui=$(CAUCE_OPENCLAW_NODE=$OPENCLAW_NODE_FOUND CAUCE_OPENCLAW_ENTRY=$OPENCLAW_ENTRY \
          CAUCE_OPENCLAW_STATE=$state_directory CAUCE_OPENCLAW_HISTORY=$OPENCLAW_HISTORY_LIMIT \
          PYTHONDONTWRITEBYTECODE=1 python3 -c \
          'import json,os;print(json.dumps({"node":os.environ["CAUCE_OPENCLAW_NODE"],"entry":os.environ["CAUCE_OPENCLAW_ENTRY"],"state_directory":os.environ["CAUCE_OPENCLAW_STATE"],"history_limit":int(os.environ["CAUCE_OPENCLAW_HISTORY"])}))') \
          || die "cannot assemble the dynamic openclaw harness resolver"
        # No native id or store key in the journal: the launcher accredits that a pointer exists,
        # the exact selection is re-resolved inside the agent on every OPEN.
        printf 'cauce-pty-launcher: dynamic openclaw tui resolver enabled alias=%s\n' \
          "$alias_name" >&2
      else
        harness_command=null
        printf 'cauce-pty-launcher: no live tmux session and no openclaw tui for alias=%s socket=%s; agent will publish shell only\n' \
          "$alias_name" "$TMUX_SOCKET" >&2
      fi
    fi
  fi
  # Runtime facts enrich presence/governance but are not a precondition for terminal transport.
  # Zero/ambiguous evidence -- or an unreadable adapter generation -- degrades to `{}`, never a stop.
  read_adapter_generation || adapter_generation=''
  runtime_facts=$(measure_adapter_runtime_facts)
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
  CAUCE_PTY_BUNDLE_TMUX_TUI=$tmux_tui \
  CAUCE_PTY_BUNDLE_OPENCLAW_TUI=$openclaw_tui \
  CAUCE_PTY_BUNDLE_RUNTIME_FACTS=$runtime_facts \
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
    "tmux_tui": commands(os.environ["CAUCE_PTY_BUNDLE_TMUX_TUI"], "TMUX_TUI"),
    "openclaw_tui": commands(os.environ["CAUCE_PTY_BUNDLE_OPENCLAW_TUI"], "OPENCLAW_TUI"),
    "runtime_facts": commands(os.environ["CAUCE_PTY_BUNDLE_RUNTIME_FACTS"], "RUNTIME_FACTS"),
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
  # Only names, owner, and mode: the bundle body (channel key, certificate, alias key) is never printed.
  printf 'cauce-pty-launcher: bundle published alias=%s path=%s owner=%s:%s mode=0400\n' \
    "$alias_name" "$bundle_path" "$runtime_uid" "$runtime_gid" >&2
}

# Host flock dies with the `docker exec` client, but the Python agent INSIDE the container
# survives. Two agents of the same alias share a certificate and the relay kicks each other
# out forever. Before starting, kill any prior agent of the alias inside the container (match
# by exact script name so no other process is targeted).
reap_orphan_agents() {
  local victims
  victims=$(docker exec "$container_id" sh -c \
    "ps -eo pid,args | awk -v s=\"cauce-pty-agent-$alias_name.py\" 'index(\$0, s) && \$2 != \"awk\" {print \$1}'" 2>/dev/null) || true
  [[ -n ${victims:-} ]] || return 0
  printf 'cauce-pty-launcher: reaping orphan agents alias=%s pids=%s\n' "$alias_name" "$(tr '\n' ' ' <<<"$victims")" >&2
  while IFS= read -r pid; do
    [[ $pid =~ ^[0-9]+$ ]] || continue
    docker exec "$container_id" sh -c \
      "ps -o args= -p $pid 2>/dev/null | grep -qF 'cauce-pty-agent-$alias_name.py' && kill $pid" 2>/dev/null || true
  done <<<"$victims"
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
  # bundle names a generation that no longer exists and no ticket for it can ever verify, so
  # abort and let systemd start a fresh launch.
  read_generation
  [[ $container_generation == "$previous_generation" ]] || die 'container generation changed during publication' 75
  reap_orphan_agents
  printf 'cauce-pty-launcher: exec agent alias=%s container=%s generation=%s uid=%s\n' \
    "$alias_name" "${container_id:0:12}" "$container_generation" "$runtime_uid" >&2
  exec docker exec -i --user "$runtime_uid:$runtime_gid" "$container_id" \
    /usr/bin/python3 "$agent_path" --bundle "$bundle_path"
}

start_agent
