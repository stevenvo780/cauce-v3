#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
family=${1:?usage: cutover.sh host-native|container ALIAS DRAIN-SNAPSHOT.json}
alias_name=${2:?usage: cutover.sh host-native|container ALIAS DRAIN-SNAPSHOT.json}
drain_snapshot=${3:?usage: cutover.sh host-native|container ALIAS DRAIN-SNAPSHOT.json}
[[ $family == host-native || $family == container ]] || { printf 'runtime family must be host-native or container\n' >&2; exit 2; }
[[ $alias_name =~ ^[a-z][a-z0-9-]*$ ]] || { printf 'invalid alias\n' >&2; exit 2; }
change_id=${CAUCE_CHANGE_ID:?set a non-secret change/ticket ID}
[[ $change_id =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'invalid CAUCE_CHANGE_ID\n' >&2; exit 2; }
[[ ${CAUCE_CUTOVER_CONFIRM:-} == "cutover:$family:$alias_name:$change_id" ]] || {
  printf 'cutover refused; set CAUCE_CUTOVER_CONFIRM=cutover:%s:%s:%s\n' "$family" "$alias_name" "$change_id" >&2
  exit 2
}
: "${CAUCE_GATE_CAPTURE_PATH:?set an absolute executable gate snapshot collector}"
[[ $CAUCE_GATE_CAPTURE_PATH == /* && -x $CAUCE_GATE_CAPTURE_PATH && ! -L $CAUCE_GATE_CAPTURE_PATH ]] || { printf 'gate collector must be an absolute executable non-symlink\n' >&2; exit 2; }
: "${CAUCE_GATE_PROBE_PATH:?set an absolute executable authentic round-trip probe}"
[[ $CAUCE_GATE_PROBE_PATH == /* && -x $CAUCE_GATE_PROBE_PATH && ! -L $CAUCE_GATE_PROBE_PATH ]] || {
  printf 'round-trip probe must be an absolute executable non-symlink\n' >&2
  exit 2
}
command -v systemctl >/dev/null 2>&1 || { printf 'systemctl is required\n' >&2; exit 127; }
command -v flock >/dev/null 2>&1 || { printf 'flock is required\n' >&2; exit 127; }
systemd_scope=${CAUCE_SYSTEMD_SCOPE:-}
if [[ -z $systemd_scope ]]; then
  if (( EUID == 0 )); then systemd_scope=system; else systemd_scope=user; fi
fi
[[ $systemd_scope == system || $systemd_scope == user ]] || { printf 'CAUCE_SYSTEMD_SCOPE must be system or user\n' >&2; exit 2; }
systemctl_cmd=(systemctl)
[[ $systemd_scope == user ]] && systemctl_cmd+=(--user)
supervisor="$ROOT/scripts/container-adapter-supervisor.sh"
if [[ ${CAUCE_CUTOVER_TEST_MODE:-0} == 1 ]]; then
  supervisor=${CAUCE_CUTOVER_TEST_SUPERVISOR:?test supervisor path is required}
  [[ $supervisor == /* && -x $supervisor ]] || { printf 'test supervisor must be an absolute executable\n' >&2; exit 2; }
fi
# Serialize every cutover/rollback for this alias on a shared host lock. Prefer
# /run/lock only when writable; rootless installs use XDG runtime/state instead.
system_lock_dir=${CAUCE_CUTOVER_SYSTEM_LOCK_DIR:-/run/lock}
if [[ -n ${CAUCE_CUTOVER_LOCK_DIR:-} ]]; then
  lock_dir=$CAUCE_CUTOVER_LOCK_DIR
elif [[ -d $system_lock_dir && -w $system_lock_dir ]]; then
  lock_dir=$system_lock_dir
elif [[ -n ${XDG_RUNTIME_DIR:-} ]]; then
  lock_dir="$XDG_RUNTIME_DIR/cauce-v3"
else
  lock_dir="${XDG_STATE_HOME:-$HOME/.local/state}/cauce-v3/lock"
fi
[[ $lock_dir == /* && ! -L $lock_dir ]] || { printf 'cutover lock dir is invalid: %s\n' "$lock_dir" >&2; exit 2; }
if [[ ! -e $lock_dir ]]; then mkdir -p -- "$lock_dir" && chmod 0700 "$lock_dir"; fi
[[ -d $lock_dir && ! -L $lock_dir && -w $lock_dir ]] || { printf 'cutover lock dir is unavailable: %s\n' "$lock_dir" >&2; exit 2; }
exec 8>"$lock_dir/cauce-v3-cutover-$alias_name.lock"
flock -n 8 || { printf 'cutover refused: another cutover or rollback holds the alias lock for %s\n' "$alias_name" >&2; exit 73; }
node "$ROOT/scripts/migration-gate.mjs" drain "$drain_snapshot" "$alias_name"
host_unit="cauce-v3-alias-$alias_name.service"
container_unit="cauce-v3-container-$alias_name.service"
if [[ $family == container ]]; then unit=$container_unit; other=$host_unit; else unit=$host_unit; other=$container_unit; fi
if "${systemctl_cmd[@]}" is-active --quiet "$host_unit" || "${systemctl_cmd[@]}" is-active --quiet "$container_unit"; then
  printf 'cutover refused: a V3 runtime family is already active for %s\n' "$alias_name" >&2
  exit 73
fi
if "${systemctl_cmd[@]}" is-enabled --quiet "$other" || "${systemctl_cmd[@]}" is-enabled --quiet "$unit"; then
  printf 'cutover refused: a V3 runtime family is already enabled and could resurrect during the gate\n' >&2
  exit 73
fi
post=$(mktemp)
probe_evidence=$(mktemp)
rollback_on_error() { "${systemctl_cmd[@]}" disable --now "$unit" >/dev/null 2>&1 || true; }
cleanup() { rm -f "$post" "$probe_evidence"; }
trap 'rollback_on_error; cleanup' ERR
trap cleanup EXIT
"${systemctl_cmd[@]}" start "$unit"
"${systemctl_cmd[@]}" is-active --quiet "$unit" || { printf 'selected V3 runtime did not become active\n' >&2; rollback_on_error; exit 1; }
if "${systemctl_cmd[@]}" is-active --quiet "$other" || "${systemctl_cmd[@]}" is-enabled --quiet "$other"; then
  printf 'both V3 runtime families overlap after cutover start (alternate must stay inactive and disabled)\n' >&2
  rollback_on_error
  exit 73
fi
if [[ $family == container ]]; then
  "$supervisor" check "$alias_name"
fi
"$CAUCE_GATE_PROBE_PATH" "$alias_name" "$probe_evidence"
CAUCE_GATE_BASELINE_FILE="$drain_snapshot" CAUCE_GATE_PROBE_EVIDENCE_FILE="$probe_evidence" \
  "$CAUCE_GATE_CAPTURE_PATH" "$alias_name" "$post" post-cutover
node "$ROOT/scripts/migration-gate.mjs" post-cutover "$post" "$alias_name"
"${systemctl_cmd[@]}" enable "$unit"
"${systemctl_cmd[@]}" is-enabled --quiet "$unit" || { printf 'selected V3 runtime could not be enabled after its gate\n' >&2; rollback_on_error; exit 1; }
trap - ERR
printf 'V3 %s consumer started and uniquely gated for %s; V2 was not changed\n' "$family" "$alias_name"
