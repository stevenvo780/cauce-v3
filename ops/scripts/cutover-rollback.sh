#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
family=${1:?usage: cutover-rollback.sh host-native|container ALIAS LIVE-SNAPSHOT.json}
alias_name=${2:?usage: cutover-rollback.sh host-native|container ALIAS LIVE-SNAPSHOT.json}
live_snapshot=${3:?usage: cutover-rollback.sh host-native|container ALIAS LIVE-SNAPSHOT.json}
[[ $family == host-native || $family == container ]] || { printf 'runtime family must be host-native or container\n' >&2; exit 2; }
[[ $alias_name =~ ^[a-z][a-z0-9-]*$ ]] || { printf 'invalid alias\n' >&2; exit 2; }
change_id=${CAUCE_CHANGE_ID:?set a non-secret change/ticket ID}
[[ $change_id =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'invalid CAUCE_CHANGE_ID\n' >&2; exit 2; }
[[ ${CAUCE_ROLLBACK_CONFIRM:-} == "stop-v3:$family:$alias_name:$change_id" ]] || {
  printf 'rollback refused; set CAUCE_ROLLBACK_CONFIRM=stop-v3:%s:%s:%s\n' "$family" "$alias_name" "$change_id" >&2
  exit 2
}
: "${CAUCE_GATE_CAPTURE_PATH:?set an absolute executable gate snapshot collector}"
[[ $CAUCE_GATE_CAPTURE_PATH == /* && -x $CAUCE_GATE_CAPTURE_PATH ]] || { printf 'gate collector must be an absolute executable\n' >&2; exit 2; }
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
# Same shared per-alias host lock as cutover.sh. Rootless installs fall back to
# XDG runtime/state when /run/lock is not writable.
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
[[ $lock_dir == /* && ! -L $lock_dir ]] || { printf 'rollback lock dir is invalid: %s\n' "$lock_dir" >&2; exit 2; }
if [[ ! -e $lock_dir ]]; then mkdir -p -- "$lock_dir" && chmod 0700 "$lock_dir"; fi
[[ -d $lock_dir && ! -L $lock_dir && -w $lock_dir ]] || { printf 'rollback lock dir is unavailable: %s\n' "$lock_dir" >&2; exit 2; }
exec 8>"$lock_dir/cauce-v3-cutover-$alias_name.lock"
flock -n 8 || { printf 'rollback refused: another cutover or rollback holds the alias lock for %s\n' "$alias_name" >&2; exit 73; }
node "$ROOT/scripts/migration-gate.mjs" rollback-drain "$live_snapshot" "$alias_name"
host_unit="cauce-v3-alias-$alias_name.service"
container_unit="cauce-v3-container-$alias_name.service"
if [[ $family == container ]]; then unit=$container_unit; other=$host_unit; else unit=$host_unit; other=$container_unit; fi
if "${systemctl_cmd[@]}" is-active --quiet "$other" || "${systemctl_cmd[@]}" is-enabled --quiet "$other"; then
  printf 'rollback refused: alternate V3 runtime family is active or enabled\n' >&2
  exit 73
fi
"${systemctl_cmd[@]}" disable --now "$unit"
if "${systemctl_cmd[@]}" is-active --quiet "$unit"; then
  printf 'rollback failed: selected V3 unit remains active\n' >&2
  exit 1
fi
if "${systemctl_cmd[@]}" is-enabled --quiet "$unit"; then
  printf 'rollback failed: selected V3 unit remains enabled and could resurrect\n' >&2
  exit 1
fi
# Rollback-ready requires BOTH V3 families provably inactive AND disabled, so neither
# host-native nor container can resurrect once V2 is restored.
for family_unit in "$host_unit" "$container_unit"; do
  if "${systemctl_cmd[@]}" is-active --quiet "$family_unit" || "${systemctl_cmd[@]}" is-enabled --quiet "$family_unit"; then
    printf 'rollback refused: %s is still active or enabled; both V3 families must be down before rollback-ready\n' "$family_unit" >&2
    exit 73
  fi
done
if [[ $family == container ]]; then
  "$supervisor" stopped "$alias_name"
fi
post=$(mktemp)
trap 'rm -f "$post"' EXIT
"$CAUCE_GATE_CAPTURE_PATH" "$alias_name" "$post" rollback-ready
node "$ROOT/scripts/migration-gate.mjs" rollback-ready "$post" "$alias_name"
printf 'V3 %s is disabled, stopped and negatively checked for %s; V2 was not touched and is only now rollback-ready\n' "$family" "$alias_name"
