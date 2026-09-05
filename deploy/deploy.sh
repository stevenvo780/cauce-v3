#!/usr/bin/env bash
# Simple Cauce V3 deploy (PHASE 3). Replaces retired machinery (history in git).
# Contract: build -> pin by digest -> migrate -> up -> smoke -> record. All or rollback.
# Owner MUST be present: requires CAUCE_FASE3_CON_DUENO=si.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${CAUCE_ENV_FILE:-/etc/cauce-v3/prod.env}"
REGISTRY="${CAUCE_DEPLOY_REGISTRY:-127.0.0.1:5000}"
EXPECTED_GIT_REF="${CAUCE_DEPLOY_EXPECTED_GIT_REF:-origin/main}"
HISTORY_FILE="${CAUCE_DEPLOY_HISTORY_FILE:-$REPO/deploy/HISTORIAL.md}"
BACKUP_STATUS_FILE="${CAUCE_DEPLOY_BACKUP_STATUS_FILE:-/var/log/cauce-v3-backup/status.json}"
BACKUP_MAX_AGE_HOURS="${CAUCE_DEPLOY_BACKUP_MAX_AGE_HOURS:-24}"
BACKUP_MONITOR="${CAUCE_DEPLOY_BACKUP_MONITOR:-$REPO/ops/scripts/host-backup-monitor.sh}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$REPO/deploy/compose.yaml" -f "$REPO/deploy/compose.postgres.yaml" --project-directory "$REPO/deploy")

die() { echo "deploy: $*" >&2; exit 1; }
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d '\r'; }
profile_enabled() {
  local wanted="$1" profile
  local -a configured_profiles=()
  IFS=',' read -r -a configured_profiles <<< "$(env_value COMPOSE_PROFILES)"
  for profile in "${configured_profiles[@]}"; do
    profile="${profile//[[:space:]]/}"
    [ "$profile" = "$wanted" ] && return 0
  done
  return 1
}
# Prompts are skipped only when the owner pre-authorised the run (CAUCE_DEPLOY_CONFIRMADO=si).
confirmar() {
  if [ "${CAUCE_DEPLOY_CONFIRMADO:-}" = "si" ]; then echo "confirmado por el dueño (entorno): $1"; return 0; fi
  read -r -p "$1 (si/NO) " ok; [ "$ok" = "si" ]
}

[ "${CAUCE_FASE3_CON_DUENO:-}" = "si" ] || die "FASE 3 solo con el dueño presente (exporta CAUCE_FASE3_CON_DUENO=si)"
[ "$(id -u)" = 0 ] || die "necesita root (lee $ENV_FILE y reescribe pins)"
[ -r "$ENV_FILE" ] || die "no puedo leer $ENV_FILE"
REGISTRY="${REGISTRY%/}"
[[ "$REGISTRY" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$ ]] || die "CAUCE_DEPLOY_REGISTRY invalido"
[[ "$EXPECTED_GIT_REF" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*$ ]] || die "CAUCE_DEPLOY_EXPECTED_GIT_REF invalido"
[[ "$HISTORY_FILE" = /* ]] || die "CAUCE_DEPLOY_HISTORY_FILE debe ser absoluto"
[[ "$BACKUP_STATUS_FILE" = /* ]] || die "CAUCE_DEPLOY_BACKUP_STATUS_FILE debe ser absoluto"
[[ "$BACKUP_MONITOR" = /* ]] || die "CAUCE_DEPLOY_BACKUP_MONITOR debe ser absoluto"
[ -x "$BACKUP_MONITOR" ] || die "CAUCE_DEPLOY_BACKUP_MONITOR no es ejecutable: $BACKUP_MONITOR"
if ! [[ "$BACKUP_MAX_AGE_HOURS" =~ ^[0-9]+$ ]] \
   || [ "$BACKUP_MAX_AGE_HOURS" -lt 1 ]; then
  die "CAUCE_DEPLOY_BACKUP_MAX_AGE_HOURS debe ser un entero positivo"
fi
[ -d "$(dirname "$HISTORY_FILE")" ] || die "no existe el directorio de historial $(dirname "$HISTORY_FILE")"
[ ! -L "$HISTORY_FILE" ] || die "CAUCE_DEPLOY_HISTORY_FILE no puede ser un symlink"
cd "$REPO"
[ -z "$(git status --porcelain)" ] || die "el arbol no esta limpio; commitea o descarta antes de desplegar"
git fetch -q origin || die "no pude hacer fetch de origin"
EXPECTED_COMMIT="$(git rev-parse --verify "${EXPECTED_GIT_REF}^{commit}" 2>/dev/null)" \
  || die "no pude resolver CAUCE_DEPLOY_EXPECTED_GIT_REF=$EXPECTED_GIT_REF"
[ "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT" ] \
  || die "HEAD != $EXPECTED_GIT_REF; sincroniza primero"

REV="$(git rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUNTIME_TAG="$REGISTRY/cauce-v3-runtime:$REV"
CONSOLE_TAG="$REGISTRY/cauce-v3-console:$REV"
LAST_MIGRATION="$(find "$REPO/packages/store/migrations" -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort -V | tail -1)" # never hardcode this: derive from what is actually bundled
[ -n "$LAST_MIGRATION" ] || die "no encuentro migraciones en packages/store/migrations"

echo "== Cauce V3 deploy: commit $REV ($STAMP) =="

if ! STATUS_FILE="$BACKUP_STATUS_FILE" MAX_AGE_HOURS="$BACKUP_MAX_AGE_HOURS" \
  "$BACKUP_MONITOR" >/dev/null; then
  echo "AVISO: el estado de backup no acredita una copia sana de <${BACKUP_MAX_AGE_HOURS}h en $BACKUP_STATUS_FILE."
  confirmar "¿Continuar igual?" || die "abortado por falta de backup fresco"
fi

# Both images come from deploy/Dockerfile: `runtime` is NOT the last stage (console is), so the
# target is explicit; the console stage bakes the relay instance id into its nginx route at build.
TERMINAL_ENABLED="$(env_value CAUCE_TERMINAL_ENABLED)"
TERMINAL_ENABLED="${TERMINAL_ENABLED:-0}"
case "$TERMINAL_ENABLED" in
  0)
    profile_enabled terminal && die "el perfil terminal esta activo pero CAUCE_TERMINAL_ENABLED=0"
    INSTANCE_ID="$(env_value CAUCE_TERMINAL_RELAY_INSTANCE_ID)"
    [[ $INSTANCE_ID =~ ^[0-9a-f]{64}$ ]] || INSTANCE_ID="$(printf '0%.0s' {1..64})"
    export CAUCE_GATEWAY_RELAY_CLIENT_CERT_PATH=/dev/null
    export CAUCE_GATEWAY_RELAY_CLIENT_KEY_PATH=/dev/null
    ;;
  1)
    profile_enabled terminal || die "CAUCE_TERMINAL_ENABLED=1 exige el perfil terminal"
    INSTANCE_ID="$(env_value CAUCE_TERMINAL_RELAY_INSTANCE_ID)"
    [[ $INSTANCE_ID =~ ^[0-9a-f]{64}$ ]] \
      || die "CAUCE_TERMINAL_RELAY_INSTANCE_ID ausente o invalido en $ENV_FILE (dossier B2)"
    CLIENT_CERT="$(env_value CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH)"
    [ -r "$CLIENT_CERT" ] || die "no puedo leer CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH ($CLIENT_CERT)"
    [ "$(openssl x509 -in "$CLIENT_CERT" -outform DER | sha256sum | awk '{print $1}')" = "$INSTANCE_ID" ] \
      || die "CAUCE_TERMINAL_RELAY_INSTANCE_ID no es el sha256 del DER de $CLIENT_CERT"
    ;;
  *) die "CAUCE_TERMINAL_ENABLED debe ser 0 o 1" ;;
esac
export CAUCE_TERMINAL_RELAY_INSTANCE_ID="$INSTANCE_ID"
docker build -f deploy/Dockerfile --target runtime --build-arg "CAUCE_SCHEMA_COMPATIBLE_THROUGH=$LAST_MIGRATION" --label "org.opencontainers.image.revision=$REV" -t "$RUNTIME_TAG" .
docker build -f deploy/Dockerfile --target console --build-arg "CAUCE_TERMINAL_RELAY_INSTANCE_ID=$INSTANCE_ID" \
  --label "org.opencontainers.image.revision=$REV" -t "$CONSOLE_TAG" .
[ "$(docker inspect --format '{{index .Config.Labels "io.cauce.terminal-relay.instance-id"}}' "$CONSOLE_TAG")" = "$INSTANCE_ID" ] \
  || die "la imagen de consola no lleva el instance id horneado"
docker push -q "$RUNTIME_TAG" && docker push -q "$CONSOLE_TAG"
RUNTIME_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$RUNTIME_TAG")"
CONSOLE_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$CONSOLE_TAG")"
echo "runtime: $RUNTIME_DIGEST"
echo "console: $CONSOLE_DIGEST"

cp -a "$ENV_FILE" "$ENV_FILE.pre-deploy-$STAMP"
sed -i "s|^CAUCE_RUNTIME_IMAGE=.*|CAUCE_RUNTIME_IMAGE=$RUNTIME_DIGEST|" "$ENV_FILE"
sed -i "s|^CAUCE_CONSOLE_IMAGE=.*|CAUCE_CONSOLE_IMAGE=$CONSOLE_DIGEST|" "$ENV_FILE"

"${COMPOSE[@]}" config >/dev/null || die "el compose canonico no renderiza con $ENV_FILE"

confirmar "¿Migrar hasta $LAST_MIGRATION (bundle de packages/store/migrations, una transaccion) y desplegar $REV?" || die "abortado por el dueño"

# B1 re-checked at the last instant, only while schema 034 is still pending: once applied, open TUIs are normal.
PG_CONTAINER="$(env_value COMPOSE_PROJECT_NAME)-postgres-1"
PG_USER="$(env_value POSTGRES_USER)"; PG_DB="$(env_value POSTGRES_DB)"
if docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  aplicada_034="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM schema_migrations WHERE version LIKE '034_%'" 2>/dev/null || echo 0)"
  if [ "$aplicada_034" = "0" ]; then
    fantasmas="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL")"
    [ "$fantasmas" = "0" ] || die "hay $fantasmas sesiones de terminal sin anclar: la 034 abortaria (dossier B1: repite el UPDATE y reintenta)"
  fi
else
  echo "PostgreSQL nuevo: la comprobacion de sesiones previas no aplica antes del primer migrator."
fi
"${COMPOSE[@]}" run --rm -T migrator || die "migracion fallida (rollback automatico en BD, sigue en la version previa); pero $ENV_FILE YA apunta a los digests nuevos (runtime=$RUNTIME_DIGEST console=$CONSOLE_DIGEST) y no se levanto ningun contenedor con ellos. Restaura antes de reintentar: cp -a $ENV_FILE.pre-deploy-$STAMP $ENV_FILE"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 --remove-orphans || die "up fallo; para volver: restaurar $ENV_FILE.pre-deploy-$STAMP y repetir up"
CAUCE_ENV_FILE="$ENV_FILE" "$REPO/deploy/refresh-observability.sh" \
  || die "no se pudieron refrescar los bind mounts de observabilidad"
CAUCE_ENV_FILE="$ENV_FILE" "$REPO/deploy/smoke.sh" \
  || die "SMOKE ROJO: evalua rollback (restaurar $ENV_FILE.pre-deploy-$STAMP + up -d --wait). La BD ya esta en $LAST_MIGRATION."

echo "| $STAMP | $REV | $RUNTIME_DIGEST | $CONSOLE_DIGEST | smoke OK |" >> "$HISTORY_FILE"
echo "== deploy $REV COMPLETO. Registra el resultado en $HISTORY_FILE. =="
