#!/usr/bin/env bash
set -euo pipefail
umask 077

# Installs or refreshes the PTY user unit for ONE alias and proves the outbound path exists
# before enabling anything. Idempotent; never touches cauce-v3-container-* adapters.
# Remote invocations must avoid heredocs and nested quoting:
#   ssh <host> "echo '<base64 of this command line>' | base64 -d | bash -l"

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OPS_ROOT=${CAUCE_PTY_OPS_ROOT:-$(cd "$SCRIPT_ROOT/.." && pwd)}
xdg_config_home=${XDG_CONFIG_HOME:-$HOME/.config}
CONFIG_ROOT=${CAUCE_PTY_CONFIG_ROOT:-$xdg_config_home/cauce-v3/pty}
PKI_ROOT=${CAUCE_PTY_PKI_ROOT:-$xdg_config_home/cauce-v3/pty-pki}
UNIT_ROOT=${CAUCE_PTY_UNIT_ROOT:-$xdg_config_home/systemd/user}
UNIT_SOURCE="$SCRIPT_ROOT/systemd/cauce-v3-pty@.service"
PREFLIGHT_ONLY=0
ENABLE_UNIT=0

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

note() { printf 'install-pty-agent: %s\n' "$1" >&2; }

docker_control() { timeout -k 5 "${CAUCE_PTY_DOCKER_TIMEOUT:-30}" docker "$@"; }

usage() {
  cat >&2 <<'USAGE'
usage: install-pty-agent.sh [--preflight-only] [--enable] ALIAS
  --preflight-only  run every check and install nothing
  --enable          systemctl --user enable --now the unit for ALIAS (default: install + preflight only)
USAGE
  exit 2
}

alias_name=''
while (( $# > 0 )); do
  case "$1" in
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    --enable) ENABLE_UNIT=1 ;;
    -h|--help) usage ;;
    -*) die "unknown option: $1" ;;
    *) [[ -z $alias_name ]] || usage; alias_name=$1 ;;
  esac
  shift
done
[[ $alias_name =~ ^[a-z][a-z0-9-]*$ ]] || usage
(( EUID != 0 )) || die 'install-pty-agent.sh must run as the unprivileged fleet user (stev), never as root' 78
command -v docker >/dev/null 2>&1 || die 'docker is unavailable' 127
command -v systemctl >/dev/null 2>&1 || die 'systemctl is unavailable' 127

config_file="$CONFIG_ROOT/$alias_name.env"
pki_dir="$PKI_ROOT/$alias_name"
key_file="$pki_dir/alias-key.hex"

check_owner_mode() {
  local path=$1 expected_mode=$2 label=$3 owner mode
  [[ -f $path && ! -L $path ]] || die "$label is missing or not a regular file: $path"
  owner=$(stat -c '%u' "$path") || die "cannot inspect $label"
  mode=$(stat -c '%a' "$path") || die "cannot inspect $label"
  [[ $owner == "$EUID" ]] || die "$label must be owned by uid $EUID (found $owner): $path"
  [[ $mode == "$expected_mode" ]] || die "$label must have mode $expected_mode (found $mode): $path"
  note "ok $label path=$path owner=$owner mode=$mode bytes=$(stat -c '%s' "$path")"
}

# 1. Alias mapping (read-only use of the ops/scripts fleet mapping).
mapping_line=$(PYTHONDONTWRITEBYTECODE=1 python3 "$OPS_ROOT/scripts/container-alias-query.py" "$alias_name") || exit $?
# shellcheck disable=SC2034  # positional fields from the mapping; not all are used here
IFS=$'\t' read -r tenant room container_name container_user container_home state_directory harness extra <<<"$mapping_line"
[[ -n $container_name && -n $container_user && -z ${extra:-} ]] || die 'container alias mapping returned invalid fields'
note "alias=$alias_name tenant=$tenant container=$container_name user=$container_user harness=$harness"

# 2. Alias config and channel material.
[[ -d $CONFIG_ROOT ]] || die "PTY config root is missing: $CONFIG_ROOT"
check_owner_mode "$config_file" 600 'PTY alias config'
relay_host=$(sed -n 's/^RELAY_HOST=//p' "$config_file" | head -n1)
relay_port=$(sed -n 's/^RELAY_PORT=//p' "$config_file" | head -n1)
[[ $relay_host =~ ^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$ ]] || die 'RELAY_HOST is missing or invalid in the alias config'
[[ $relay_port =~ ^[0-9]{1,5}$ ]] || die 'RELAY_PORT is missing or invalid in the alias config'
for name in client.crt client.key ca.crt; do
  check_owner_mode "$pki_dir/$name" 600 "PTY channel material ($name)"
done
# The derived per-alias ticket key. 0400 on purpose: read once per launch, never written.
check_owner_mode "$key_file" 400 'PTY alias key'
[[ $(stat -c '%s' "$key_file") -ge 64 ]] || die 'PTY alias key must hold 64 hex characters'

# 3. Container preflight. Runs INSIDE the container, because that is where the agent will run;
# the only path that matters is the outbound one.
container_id=$(docker_control inspect --format '{{.Id}}' "$container_name") || die "container is not inspectable: $container_name" 1
[[ $container_id =~ ^[a-f0-9]{64}$ ]] || die 'container id is invalid'
running=$(docker_control inspect --format '{{.State.Running}}' "$container_id") || die 'cannot read container state'
[[ $running == true ]] || die "container is not running: $container_name" 1
runtime_uid=$(docker_control exec "$container_id" id -u "$container_user") || die 'mapped container user is unavailable' 1
runtime_gid=$(docker_control exec "$container_id" id -g "$container_user") || die 'mapped container group is unavailable' 1
runtime_uid=${runtime_uid//[$'\r\n']/}
runtime_gid=${runtime_gid//[$'\r\n']/}
[[ $runtime_uid =~ ^[0-9]+$ && $runtime_gid =~ ^[0-9]+$ ]] || die 'container runtime identity is invalid' 1
[[ $runtime_uid != 0 && $runtime_gid != 0 ]] || die 'container runtime identity must not be root' 78
note "runtime identity inside $container_name: $container_user uid=$runtime_uid gid=$runtime_gid"

docker_control exec --user "$runtime_uid:$runtime_gid" "$container_id" test -x /usr/bin/python3 \
  || die "/usr/bin/python3 is missing inside $container_name; the PTY agent cannot run there" 1
note "ok /usr/bin/python3 exists inside $container_name"

# Outbound TCP reachability of the relay FROM INSIDE the container, with the stdlib only.
if docker_control exec --user "$runtime_uid:$runtime_gid" -e CAUCE_PTY_RELAY_HOST="$relay_host" -e CAUCE_PTY_RELAY_PORT="$relay_port" \
  "$container_id" /usr/bin/python3 -c \
  'import os,socket,sys
host=os.environ["CAUCE_PTY_RELAY_HOST"]; port=int(os.environ["CAUCE_PTY_RELAY_PORT"])
try:
    socket.create_connection((host,port),timeout=5).close()
except OSError as error:
    sys.exit(f"{type(error).__name__}: {error}")'; then
  note "ok outbound TCP to $relay_host:$relay_port from inside $container_name"
else
  die "the container cannot reach the terminal relay at $relay_host:$relay_port; the PTY channel would never connect" 1
fi

if (( PREFLIGHT_ONLY == 1 )); then
  note 'preflight only: nothing was installed'
  exit 0
fi

# 4. Unit installation. Idempotent: template is rewritten only when its body differs.
[[ -f $UNIT_SOURCE ]] || die "unit template is missing: $UNIT_SOURCE"
mkdir -p -- "$UNIT_ROOT"
target="$UNIT_ROOT/cauce-v3-pty@.service"
if [[ -f $target ]] && cmp -s "$UNIT_SOURCE" "$target"; then
  note "unit is already current: $target"
else
  install -m 0644 "$UNIT_SOURCE" "$target"
  note "unit installed: $target"
  systemctl --user daemon-reload
fi

if (( ENABLE_UNIT == 1 )); then
  # Only this alias instance is touched. No adapter unit is reloaded, restarted or stopped.
  systemctl --user enable --now "cauce-v3-pty@$alias_name.service"
  note "enabled cauce-v3-pty@$alias_name.service"
  systemctl --user --no-pager --lines=0 status "cauce-v3-pty@$alias_name.service" || true
else
  note "not enabled. To start it: systemctl --user enable --now cauce-v3-pty@$alias_name.service"
fi
