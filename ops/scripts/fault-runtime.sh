#!/bin/sh
set -eu

target=${1:?usage: fault-runtime.sh gateway|postgres|telegram-bridge|relay-worker}
case "$target" in gateway|postgres|telegram-bridge|relay-worker) ;; *) printf 'unsupported fault target\n' >&2; exit 2 ;; esac
[ "${CAUCE_FAULT_CONFIRM:-}" = ephemeral-only ] || { printf 'fault injection refused; set CAUCE_FAULT_CONFIRM=ephemeral-only\n' >&2; exit 2; }
: "${CAUCE_RUNTIME_PREFIX:?CAUCE_RUNTIME_PREFIX is required}"
container="${CAUCE_RUNTIME_PREFIX}-${target}"
container_before=$(docker inspect --format '{{.Id}}' "$container")
pid_before=$(docker inspect --format '{{.State.Pid}}' "$container")
running_before=$(docker inspect --format '{{.State.Running}}' "$container")
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ "$running_before" = true ]; then
  docker kill --signal KILL "$container" >/dev/null
  sleep "${CAUCE_FAULT_HOLD_SECONDS:-2}"
fi
docker start "$container" >/dev/null
pid_after=$(docker inspect --format '{{.State.Pid}}' "$container")
case "$pid_after" in ''|0|*[!0-9]*) printf 'runtime fault produced an invalid PID: %s\n' "$target" >&2; exit 3 ;; esac
[ "$pid_after" != "$pid_before" ] || { printf 'runtime fault did not replace process: %s\n' "$target" >&2; exit 3; }
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
case "$target" in
  gateway) mechanism=gateway-process-kill ;;
  postgres) mechanism=postgres-container-kill ;;
  *) mechanism="$target-process-kill" ;;
esac
short_container=$(printf '%s' "$container_before" | cut -c1-12)
printf 'mechanism=%s service=%s container=%s pid_before=%s pid_after=%s started_at=%s finished_at=%s\n' \
  "$mechanism" "$target" "$short_container" "$pid_before" "$pid_after" "$started_at" "$finished_at"
