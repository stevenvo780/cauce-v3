#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:-dev}
case "$target" in
  dev) default_env="$ROOT/config/dev.env" ;;
  prod) default_env="$ROOT/config/prod.env" ;;
  *) printf 'usage: stack-health.sh [dev|prod] [--maintenance-offline-zeus]\n' >&2; exit 2 ;;
esac
if (($#)); then shift; fi
fleet_mode=final
if (($#)); then
  [[ $target == prod && $# == 1 && $1 == --maintenance-offline-zeus ]] || {
    printf 'usage: stack-health.sh [dev|prod] [--maintenance-offline-zeus]\n' >&2
    exit 2
  }
  fleet_mode=maintenance-zeus
fi
env_file=${CAUCE_ENV_FILE:-$default_env}
[[ -f "$env_file" ]] || { printf 'missing env file: %s\n' "$env_file" >&2; exit 2; }

env_value() {
  local key=$1 fallback=$2 value line
  local -a lines=()
  if [[ -v $key ]]; then printf '%s\n' "${!key}"; return; fi
  mapfile -t lines < <(sed -n "/^${key}=/p" "$env_file")
  ((${#lines[@]} <= 1)) || { printf 'duplicate %s in %s\n' "$key" "$env_file" >&2; return 2; }
  if ((${#lines[@]} == 0)); then printf '%s\n' "$fallback"; return; fi
  line=${lines[0]}; value=${line#*=}; value=${value%$'\r'}
  printf '%s\n' "$value"
}

if [[ $target == prod ]]; then
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T gateway \
    node deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T console \
    sh -c 'test -r /run/secrets/console_tls_ca && SSL_CERT_FILE=/run/secrets/console_tls_ca wget -q -O /dev/null https://console:8444/'
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T dispatcher \
    node deploy/readiness-probe.mjs http://127.0.0.1:8082/health/ready ready
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T outbox-metrics \
    node deploy/readiness-probe.mjs http://127.0.0.1:8084/health/ready ready
  configured=$(CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod config --services)
  if grep -qx relay-worker <<<"$configured"; then
    CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T relay-worker \
      node deploy/readiness-probe.mjs http://127.0.0.1:8083/health/ready ready
  fi
  if grep -qx telegram-bridge <<<"$configured"; then
    CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T telegram-bridge \
      node deploy/readiness-probe.mjs http://127.0.0.1:8086/health/ready ready
  fi
  if grep -qx terminal-relay <<<"$configured"; then
    terminal_id=$(CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod ps -q terminal-relay)
    [[ -n $terminal_id ]] || { printf 'terminal-relay is configured but not running\n' >&2; exit 1; }
    terminal_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$terminal_id")
    [[ $terminal_health == healthy ]] || { printf 'terminal-relay is not healthy\n' >&2; exit 1; }
  fi
  if grep -qx shadow-router <<<"$configured"; then
    CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T shadow-router \
      node deploy/unix-readiness-probe.mjs \
        /run/cauce-shadow/router/router.sock /health/ready ready
  fi
  CAUCE_FLEET_SNAPSHOT_FILE= CAUCE_FLEET_TEST_MODE=0 \
    CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/fleet-gate-mode.sh" "$fleet_mode"
  if [[ $fleet_mode == final ]]; then
    printf 'production core, configured relay/Telegram/terminal/shadow services, strict fleet parity and PostgreSQL TLS are ready\n'
  else
    printf 'production core and bounded Zeus maintenance checks are ready; final strict fleet gate remains mandatory\n'
  fi
  exit 0
fi

gateway_port=$(env_value GATEWAY_PORT 8080)
console_port=$(env_value CONSOLE_PORT 8081)
node "$ROOT/scripts/healthcheck.mjs" "http://127.0.0.1:$gateway_port/health/ready" ready
node -e "fetch('http://127.0.0.1:$console_port/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" dev exec -T postgres \
  sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null && test "$(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT 1")" = 1'
CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" dev exec -T dispatcher \
  node -e "fetch('http://127.0.0.1:8082/health/ready').then(r=>{if(!r.ok)process.exit(1)})"
printf 'development gateway, dispatcher, console and database are ready\n'
