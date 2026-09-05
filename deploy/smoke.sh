#!/usr/bin/env bash
# Exits 0 only if every probe configured for this stack passes.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${CAUCE_ENV_FILE:-}"
if [ -z "$ENV_FILE" ]; then
  exec "$REPO_DIR/deploy/smoke-central.sh"
fi
DOCKER_BIN="${CAUCE_SMOKE_DOCKER_BIN:-docker}"
CURL_BIN="${CAUCE_SMOKE_CURL_BIN:-curl}"
fallo=0

die() { echo "smoke: $*" >&2; exit 2; }

has_setting() {
  local key="$1"
  [[ -v "$key" ]] || grep -q "^${key}=" "$ENV_FILE"
}

setting() {
  local key="$1"
  if [[ -v "$key" ]]; then
    printf '%s' "${!key}"
    return
  fi
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -1 | tr -d '\r'
}

load_required_setting() {
  local key="$1" target="$2" value
  has_setting "$key" || die "$key debe declararse para esta instancia"
  value="$(setting "$key")"
  [ -n "$value" ] || die "$key no puede estar vacio"
  printf -v "$target" '%s' "$value"
}

nonnegative_integer() { [[ "$1" =~ ^[0-9]+$ ]]; }
positive_integer() { nonnegative_integer "$1" && [ "$1" -ge 1 ]; }

[ -n "$ENV_FILE" ] || die "CAUCE_ENV_FILE es obligatorio"
[ -r "$ENV_FILE" ] || die "no puedo leer CAUCE_ENV_FILE=$ENV_FILE"
[ -n "$DOCKER_BIN" ] || die "CAUCE_SMOKE_DOCKER_BIN no puede estar vacio"
[ -n "$CURL_BIN" ] || die "CAUCE_SMOKE_CURL_BIN no puede estar vacio"

load_required_setting COMPOSE_PROJECT_NAME PROJECT
load_required_setting POSTGRES_USER PG_USER
load_required_setting POSTGRES_DB PG_DB
load_required_setting CAUCE_CONSOLE_URL CONSOLE
load_required_setting CAUCE_CONSOLE_TLS_CA_PATH CONSOLE_CA
load_required_setting CAUCE_SMOKE_GOVERNANCE_ALIAS GOVERNANCE_ALIAS
load_required_setting CAUCE_SMOKE_GOVERNANCE_TENANT GOVERNANCE_TENANT
load_required_setting CAUCE_SMOKE_REQUIRE_GOVERNANCE_AGENT REQUIRE_GOVERNANCE_AGENT
load_required_setting CAUCE_SMOKE_EXPECTED_AGENTS EXPECTED_AGENTS
load_required_setting CAUCE_SMOKE_LEASE_FRESH_SECONDS LEASE_FRESH_SECONDS
load_required_setting CAUCE_SMOKE_MIN_ACTIVITY MIN_ACTIVITY
load_required_setting CAUCE_SMOKE_ACTIVITY_WINDOW_SECONDS ACTIVITY_WINDOW_SECONDS
load_required_setting CAUCE_SMOKE_MAX_ATTEMPTS MAX_ATTEMPTS
load_required_setting CAUCE_SMOKE_RETRY_SECONDS RETRY_SECONDS
load_required_setting CAUCE_SMOKE_RELAY_MAX_CONNECTIONS RELAY_MAX_CONNECTIONS
has_setting COMPOSE_PROFILES || die "COMPOSE_PROFILES debe declararse para esta instancia"
COMPOSE_PROFILES="$(setting COMPOSE_PROFILES)"

[[ "$PROJECT" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "COMPOSE_PROJECT_NAME invalido"
[[ "$PG_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_.-]*$ ]] || die "POSTGRES_USER invalido"
[[ "$PG_DB" =~ ^[a-zA-Z_][a-zA-Z0-9_.-]*$ ]] || die "POSTGRES_DB invalido"
[[ "$CONSOLE" =~ ^https://[^[:space:]]+$ ]] || die "CAUCE_CONSOLE_URL debe ser HTTPS"
if [[ "$CONSOLE_CA" != /* ]] || [ ! -r "$CONSOLE_CA" ]; then
  die "CAUCE_CONSOLE_TLS_CA_PATH no es legible"
fi
[[ "$GOVERNANCE_ALIAS" =~ ^[a-z][a-z0-9.-]*$ ]] || die "CAUCE_SMOKE_GOVERNANCE_ALIAS invalido"
[[ "$GOVERNANCE_TENANT" =~ ^[A-Za-z][A-Za-z0-9_-]*$ ]] || die "CAUCE_SMOKE_GOVERNANCE_TENANT invalido"
[[ "$REQUIRE_GOVERNANCE_AGENT" =~ ^[01]$ ]] || die "CAUCE_SMOKE_REQUIRE_GOVERNANCE_AGENT debe ser 0 o 1"
nonnegative_integer "$EXPECTED_AGENTS" || die "CAUCE_SMOKE_EXPECTED_AGENTS invalido"
positive_integer "$LEASE_FRESH_SECONDS" || die "CAUCE_SMOKE_LEASE_FRESH_SECONDS invalido"
nonnegative_integer "$MIN_ACTIVITY" || die "CAUCE_SMOKE_MIN_ACTIVITY invalido"
positive_integer "$ACTIVITY_WINDOW_SECONDS" || die "CAUCE_SMOKE_ACTIVITY_WINDOW_SECONDS invalido"
positive_integer "$MAX_ATTEMPTS" || die "CAUCE_SMOKE_MAX_ATTEMPTS invalido"
nonnegative_integer "$RETRY_SECONDS" || die "CAUCE_SMOKE_RETRY_SECONDS invalido"
positive_integer "$RELAY_MAX_CONNECTIONS" || die "CAUCE_SMOKE_RELAY_MAX_CONNECTIONS invalido"
[ "$EXPECTED_AGENTS" -le 1000 ] || die "CAUCE_SMOKE_EXPECTED_AGENTS fuera de rango"
[ "$MAX_ATTEMPTS" -le 60 ] || die "CAUCE_SMOKE_MAX_ATTEMPTS fuera de rango"
[ "$RETRY_SECONDS" -le 300 ] || die "CAUCE_SMOKE_RETRY_SECONDS fuera de rango"

profile_args=()
IFS=',' read -r -a profiles <<< "$COMPOSE_PROFILES"
for profile in "${profiles[@]}"; do
  profile="${profile//[[:space:]]/}"
  [ -z "$profile" ] && continue
  [[ "$profile" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "perfil Compose invalido: $profile"
  profile_args+=(--profile "$profile")
done

COMPOSE=(
  "$DOCKER_BIN" compose
  --env-file "$ENV_FILE"
  "${profile_args[@]}"
  -f "$REPO_DIR/deploy/compose.yaml"
  -f "$REPO_DIR/deploy/compose.postgres.yaml"
  --project-directory "$REPO_DIR/deploy"
)

if ! rendered_services="$("${COMPOSE[@]}" config --services)"; then
  die "el compose de $PROJECT no renderiza sus servicios activos"
fi

services=()
while IFS= read -r service; do
  [ -z "$service" ] && continue
  [ "$service" = migrator ] && continue
  [[ "$service" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || die "servicio Compose invalido: $service"
  services+=("$service")
done <<< "$rendered_services"
[ "${#services[@]}" -gt 0 ] || die "el compose de $PROJECT no declara servicios persistentes activos"

declare -A containers=()
for service in "${services[@]}"; do
  if ! ids="$("${COMPOSE[@]}" ps -q "$service")"; then
    echo "ROJO $service: compose ps fallo"
    fallo=1
    continue
  fi
  service_ids=()
  while IFS= read -r id; do [ -n "$id" ] && service_ids+=("$id"); done <<< "$ids"
  if [ "${#service_ids[@]}" -ne 1 ]; then
    echo "ROJO $service: esperaba 1 contenedor activo y encontre ${#service_ids[@]}"
    fallo=1
    continue
  fi
  container_id="${service_ids[0]}"
  containers["$service"]="$container_id"
  health="$("$DOCKER_BIN" inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || echo ausente)"
  if [ "$health" = healthy ]; then echo "OK  $service healthy"; else echo "ROJO $service: $health"; fallo=1; fi
done

gateway_id="${containers[gateway]:-}"
postgres_id="${containers[postgres]:-}"
if [ -n "$gateway_id" ] && "$DOCKER_BIN" exec "$gateway_id" \
  node /app/deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready >/dev/null 2>&1; then
  echo "OK  gateway /health/ready (probe interno)"
else
  echo "ROJO gateway /health/ready"
  fallo=1
fi

if [ -n "$postgres_id" ]; then
  PG=("$DOCKER_BIN" exec "$postgres_id" psql -X -U "$PG_USER" -d "$PG_DB" -tA -c)
else
  PG=()
fi
pg_query() { [ "${#PG[@]}" -gt 0 ] && "${PG[@]}" "$1" 2>/dev/null; }

ESPERADA="$(find "$REPO_DIR/packages/store/migrations" -maxdepth 1 -type f -name '[0-9]*.sql' -printf '%f\n' | sort | tail -1)"
if ver="$(pg_query "SELECT max(version) FROM schema_migrations")"; then :; else ver=""; fi
if [ -n "$ESPERADA" ] && [ "$ver" = "$ESPERADA" ]; then
  echo "OK  esquema $ver"
else
  echo "ROJO esquema en '$ver' (el repo declara '$ESPERADA')"
  fallo=1
fi

esperados=0
vivos=0
flota_valida=0
for ((intento = 1; intento <= MAX_ATTEMPTS; intento += 1)); do
  if censo="$(pg_query "SELECT count(*), count(*) FILTER (WHERE l.lease_until > now() AND l.last_heartbeat_at > now() - make_interval(secs => $LEASE_FRESH_SECONDS) AND l.last_heartbeat_at > l.connected_at AND l.capabilities ? 'heartbeat' AND l.instance_id IN ('systemd-'||a.alias,'systemd-container-'||a.alias)) FROM agents a LEFT JOIN connection_leases l ON l.tenant_id=a.tenant_id AND l.alias=a.alias WHERE a.enabled")" \
    && [[ "$censo" =~ ^([0-9]+)\|([0-9]+)$ ]]; then
    esperados=${BASH_REMATCH[1]}
    vivos=${BASH_REMATCH[2]}
    if [ "$esperados" -eq "$EXPECTED_AGENTS" ] && [ "$vivos" -eq "$esperados" ]; then flota_valida=1; break; fi
  fi
  [ "$intento" -lt "$MAX_ATTEMPTS" ] && [ "$RETRY_SECONDS" -gt 0 ] && sleep "$RETRY_SECONDS"
done
if [ "$flota_valida" -eq 1 ]; then
  echo "OK  flota: $vivos/$esperados agentes habilitados con arriendo vigente y fresco"
else
  echo "ROJO flota: $vivos/$esperados agentes con arriendo válido (esperados: $EXPECTED_AGENTS)"
  fallo=1
fi

if [ "$REQUIRE_GOVERNANCE_AGENT" -eq 1 ]; then
  governance_count="$(pg_query "SELECT count(*) FROM agents WHERE tenant_id='$GOVERNANCE_TENANT' AND alias='$GOVERNANCE_ALIAS' AND enabled=true" || true)"
  if [ "$governance_count" = 1 ]; then
    echo "OK  gobierno: $GOVERNANCE_TENANT/$GOVERNANCE_ALIAS existe y está habilitado"
  else
    echo "ROJO gobierno: esperaba un agente habilitado $GOVERNANCE_TENANT/$GOVERNANCE_ALIAS y observé '${governance_count:-consulta fallida}'"
    fallo=1
  fi
else
  echo "OK  gobierno: comprobación de agente diferida por bootstrap inicial"
fi

if [ -n "$gateway_id" ]; then
  arranque="$("$DOCKER_BIN" inspect --format '{{.State.StartedAt}}' "$gateway_id" 2>/dev/null || echo '')"
else
  arranque=""
fi
if [[ ! "$arranque" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then
  echo "ROJO bus: no pude leer el instante de arranque del gateway"
  fallo=1
else
  hechas="$(pg_query "SELECT count(*) FROM deliveries d WHERE d.status='done' AND d.last_ack_rank=3 AND d.terminal_at > GREATEST('$arranque'::timestamptz, now() - make_interval(secs => $ACTIVITY_WINDOW_SECONDS)) AND EXISTS (SELECT 1 FROM delivery_acks ack WHERE ack.delivery_id=d.id AND ack.status='done' AND ack.applied AND ack.attempt=d.attempt AND ack.claim_token=d.claim_token AND ack.instance_id=d.consumer_instance_id AND ack.epoch=d.consumer_epoch)" || true)"
  vivas="$(pg_query "SELECT count(*) FROM deliveries d JOIN connection_leases l ON l.tenant_id=d.recipient_tenant AND l.alias=d.recipient_alias AND l.instance_id=d.consumer_instance_id AND l.epoch=d.consumer_epoch WHERE d.terminal_at IS NULL AND d.status='started' AND d.last_ack_rank=2 AND d.execution_started_at IS NOT NULL AND d.ack_deadline_at>now() AND d.claim_expires_at>now() AND l.lease_until>now() AND l.last_heartbeat_at>now()-make_interval(secs => $LEASE_FRESH_SECONDS) AND EXISTS (SELECT 1 FROM delivery_acks ack WHERE ack.delivery_id=d.id AND ack.applied AND ack.status='started' AND ack.attempt=d.attempt AND ack.claim_token=d.claim_token AND ack.instance_id=d.consumer_instance_id AND ack.epoch=d.consumer_epoch)" || true)"
  if nonnegative_integer "$hechas" && [ "$hechas" -ge "$MIN_ACTIVITY" ]; then
    echo "OK  bus: $hechas entregas done con ACK aplicado (minimo $MIN_ACTIVITY)"
  elif nonnegative_integer "$vivas" && [ "$vivas" -ge "$MIN_ACTIVITY" ]; then
    echo "OK  bus: $vivas ejecuciones con ACK y arriendo vigentes (minimo $MIN_ACTIVITY)"
  else
    echo "ROJO bus: done=${hechas:-consulta fallida}, en vuelo=${vivas:-consulta fallida}, minimo=$MIN_ACTIVITY"
    fallo=1
  fi
fi

relay_id="${containers[terminal-relay]:-}"
if [ -n "$relay_id" ]; then
  if relay_logs="$("$DOCKER_BIN" logs "$relay_id" --since 2m 2>/dev/null)"; then
    conn="$(grep -c '"event"[[:space:]]*:[[:space:]]*"terminal_relay_agent_connected"' <<< "$relay_logs" || true)"
    if [[ "$conn" =~ ^[0-9]+$ ]] && [ "$conn" -lt "$RELAY_MAX_CONNECTIONS" ]; then
      echo "OK  relay: $conn conexiones/2min (limite $RELAY_MAX_CONNECTIONS)"
    else
      echo "ROJO relay: ${conn:-conteo fallido} conexiones/2min (limite $RELAY_MAX_CONNECTIONS)"
      fallo=1
    fi
  else
    echo "ROJO relay: no pude leer sus logs"
    fallo=1
  fi
else
  echo "OK  relay: perfil terminal inactivo"
fi

if code="$("$CURL_BIN" -sS --cacert "$CONSOLE_CA" --max-time 10 -o /dev/null -w '%{http_code}' \
  "$CONSOLE/v3/console/agents/$GOVERNANCE_ALIAS/documents" 2>/dev/null)"; then
  case "$code" in
    401|403) echo "OK  ruta documents de $GOVERNANCE_ALIAS responde $code (existe y exige autenticacion)" ;;
    *) echo "ROJO ruta documents de $GOVERNANCE_ALIAS: $code"; fallo=1 ;;
  esac
else
  echo "ROJO ruta documents de $GOVERNANCE_ALIAS: consulta HTTP fallida"
  fallo=1
fi

echo
echo "== MANUAL: editar un fichero de gobierno desde la consola y verificarlo dentro del contenedor objetivo."
exit "$fallo"
