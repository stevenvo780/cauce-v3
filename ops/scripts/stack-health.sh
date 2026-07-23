#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:-dev}
case "$target" in
  dev) default_env="$ROOT/config/dev.env" ;;
  prod) default_env="$ROOT/config/prod.env" ;;
  *) printf 'health target must be dev or prod\n' >&2; exit 2 ;;
esac
env_file=${CAUCE_ENV_FILE:-$default_env}
[[ -f "$env_file" ]] || { printf 'missing env file: %s\n' "$env_file" >&2; exit 2; }
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

if [[ $target == prod ]]; then
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T gateway \
    node deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T console \
    sh -c 'test -r /run/secrets/console_tls_ca && SSL_CERT_FILE=/run/secrets/console_tls_ca wget -q -O /dev/null https://console:8444/'
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T dispatcher \
    node deploy/readiness-probe.mjs http://127.0.0.1:8082/health/ready ready
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod exec -T outbox-metrics \
    node deploy/readiness-probe.mjs http://127.0.0.1:8084/health/ready ready
  printf 'production gateway/console TLS, dispatcher, outbox metrics and PostgreSQL TLS are ready\n'
  exit 0
fi

gateway_port=${GATEWAY_PORT:-8080}
console_port=${CONSOLE_PORT:-8081}
node "$ROOT/scripts/healthcheck.mjs" "http://127.0.0.1:$gateway_port/health/ready" ready
node -e "fetch('http://127.0.0.1:$console_port/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" dev exec -T postgres \
  sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null && test "$(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT 1")" = 1'
CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" dev exec -T dispatcher \
  node -e "fetch('http://127.0.0.1:8082/health/ready').then(r=>{if(!r.ok)process.exit(1)})"
printf 'development gateway, dispatcher, console and database are ready\n'
