#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:-dev}
case "$target" in
  dev) default_env="$ROOT/config/dev.env" ;;
  prod) default_env="$ROOT/config/prod.env" ;;
  *) printf 'usage: stack-health.sh [dev|prod]\n' >&2; exit 2 ;;
esac
if (($#)); then shift; fi
(($# == 0)) || { printf 'usage: stack-health.sh [dev|prod]\n' >&2; exit 2; }
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
  docker_bin=$(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin command -v docker)
  [[ $docker_bin = /* && -x $docker_bin ]] || { printf 'trusted Docker CLI is unavailable\n' >&2; exit 127; }
  production_container() {
    local service=$1 identifier
    identifier=$(CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod ps -q "$service")
    [[ -n $identifier ]] || { printf '%s is configured but not running\n' "$service" >&2; return 1; }
    printf '%s\n' "$identifier"
  }
  production_exec() {
    local service=$1 identifier
    shift
    identifier=$(production_container "$service") || return
    "$docker_bin" exec "$identifier" "$@"
  }

  production_exec gateway \
    node deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready
  production_exec console \
    sh -c 'test -r /run/secrets/console_tls_ca && SSL_CERT_FILE=/run/secrets/console_tls_ca wget -q -O /dev/null https://console:8444/'
  production_exec dispatcher \
    node deploy/readiness-probe.mjs http://127.0.0.1:8082/health/ready ready
  production_exec outbox-metrics \
    node deploy/readiness-probe.mjs http://127.0.0.1:8084/health/ready ready
  configured=$(CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod config --services)
  if grep -qx telegram-bridge <<<"$configured"; then
    production_exec telegram-bridge \
      node deploy/readiness-probe.mjs http://127.0.0.1:8086/health/ready ready
  fi
  if grep -qx terminal-relay <<<"$configured"; then
    terminal_id=$(production_container terminal-relay)
    terminal_health=$("$docker_bin" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$terminal_id")
    [[ $terminal_health == healthy ]] || { printf 'terminal-relay is not healthy\n' >&2; exit 1; }
  fi
  printf 'production core and configured Telegram and terminal services are ready\n'
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
