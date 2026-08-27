#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:?usage: fault-compose.sh gateway|postgres|telegram-bridge|relay-worker}
stack=${CAUCE_COMPOSE_TARGET:-test}
case "$target" in gateway|postgres|telegram-bridge|relay-worker) ;; *) printf 'unsupported fault target\n' >&2; exit 2 ;; esac
[[ ${CAUCE_FAULT_CONFIRM:-} == ephemeral-only ]] || {
  printf 'fault injection refused; set CAUCE_FAULT_CONFIRM=ephemeral-only\n' >&2
  exit 2
}

compose=("$ROOT/scripts/compose.sh" "$stack")
case "$stack" in
  test) ;;
  dev|prod)
    : "${CAUCE_ENV_FILE:?CAUCE_ENV_FILE is required for dev/prod fault injection}"
    if [[ "$stack" == prod ]]; then
      printf 'fault injection refused; CAUCE_FAULT_CONFIRM=ephemeral-only cannot target prod\n' >&2
      exit 2
    fi
    ;;
  *) printf 'unsupported compose target: %s\n' "$stack" >&2; exit 2 ;;
esac

container_before=$("${compose[@]}" ps -q "$target")
[[ -n "$container_before" ]] || { printf 'fault target is not running: %s\n' "$target" >&2; exit 3; }
pid_before=$(docker inspect -f '{{.State.Pid}}' "$container_before")
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"${compose[@]}" kill -s KILL "$target"
sleep "${CAUCE_FAULT_HOLD_SECONDS:-2}"
"${compose[@]}" up -d --no-deps "$target"
container_after=$("${compose[@]}" ps -q "$target")
[[ -n "$container_after" ]] || { printf 'fault target did not restart: %s\n' "$target" >&2; exit 3; }
pid_after=$(docker inspect -f '{{.State.Pid}}' "$container_after")
[[ "$pid_after" =~ ^[1-9][0-9]*$ ]] || { printf 'fault target has no live process: %s\n' "$target" >&2; exit 3; }
[[ "$pid_after" != "$pid_before" ]] || { printf 'process PID did not change for %s\n' "$target" >&2; exit 3; }
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
case "$target" in
  gateway) mechanism=gateway-process-kill ;;
  postgres) mechanism=postgres-container-kill ;;
  *) mechanism="$target-process-kill" ;;
esac
printf 'mechanism=%s service=%s stack=%s container_before=%s container_after=%s pid_before=%s pid_after=%s started_at=%s finished_at=%s\n' \
  "$mechanism" "$target" "$stack" "${container_before:0:12}" "${container_after:0:12}" "$pid_before" "$pid_after" "$started_at" "$finished_at"
