#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${CAUCE_ENV_FILE:-/etc/cauce-v3/prod.env}"
COMPOSE_BIN="${CAUCE_OBSERVABILITY_COMPOSE_BIN:-docker}"
WAIT_TIMEOUT="${CAUCE_OBSERVABILITY_WAIT_TIMEOUT_SECONDS:-120}"
COMPOSE=("$COMPOSE_BIN" compose --env-file "$ENV_FILE" -f "$REPO/deploy/compose.yaml" -f "$REPO/deploy/compose.postgres.yaml" --project-directory "$REPO/deploy")

die() { echo "refresh-observability: $*" >&2; exit 1; }

[ -n "$COMPOSE_BIN" ] || die "CAUCE_OBSERVABILITY_COMPOSE_BIN no puede estar vacio"
[[ $WAIT_TIMEOUT =~ ^[0-9]+$ ]] || die "timeout invalido"
[ "$WAIT_TIMEOUT" -ge 1 ] && [ "$WAIT_TIMEOUT" -le 300 ] || die "timeout fuera de rango"
[ -r "$ENV_FILE" ] || die "no puedo leer $ENV_FILE"

if ! running_services="$("${COMPOSE[@]}" ps --status running --services)"; then
  die "no pude consultar los servicios activos"
fi

active=()
for service in prometheus otel-collector; do
  while IFS= read -r running; do
    if [ "$running" = "$service" ]; then
      active+=("$service")
      break
    fi
  done <<< "$running_services"
done

if [ "${#active[@]}" -eq 0 ]; then
  echo "refresh-observability: sin servicios de observabilidad activos; no se habilita ningun perfil"
  exit 0
fi

"${COMPOSE[@]}" up -d --no-deps --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" "${active[@]}" \
  || die "fallo el refresco de observabilidad"
echo "refresh-observability: refrescados ${active[*]}"
