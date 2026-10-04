#!/usr/bin/env bash
# Simple Cauce V3 deploy (PHASE 3). Replaces retired machinery (history in git).
# Contract: build -> pin by digest -> migrate -> up -> smoke -> record. All or rollback.
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
env_declarations() { grep -Ec "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*[=:]" "$ENV_FILE" || true; }
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
prepare_terminal() {
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
}
deployment_failed() {
  echo "deploy: $*" >&2
  if [ "$MCP_HUMAN_ENABLED" = 1 ]; then
    local -a recovery=(env -u CAUCE_MCP_PUBLIC_ORIGIN -u CAUCE_MCP_OAUTH_ISSUER -u CAUCE_MCP_OAUTH_JWKS_URI
      "CAUCE_TERMINAL_RELAY_INSTANCE_ID=$INSTANCE_ID" "CAUCE_BLOB_API_ENABLED=$BLOB_API_ENABLED")
    if [ "$TERMINAL_ENABLED" = 0 ]; then
      recovery+=(CAUCE_GATEWAY_RELAY_CLIENT_CERT_PATH=/dev/null CAUCE_GATEWAY_RELAY_CLIENT_KEY_PATH=/dev/null)
    fi
    recovery+=("${COMPOSE[@]}")
    echo "Rollback MCP manual: solo despues de verificar/restaurar esquema, BD y volumen segun el error; restaura el archivo completo (flag y configuracion incluidos):" >&2
    printf 'cp -a %q %q\n' "$ENV_FILE.pre-deploy-$STAMP" "$ENV_FILE" >&2
    printf '%q ' "${recovery[@]}" >&2; printf 'config\n' >&2
    printf '%q ' "${recovery[@]}" >&2; printf 'up -d --wait --wait-timeout 300 --remove-orphans\n' >&2
  fi
  exit 1
}

[ "${CAUCE_FASE3_CON_DUENO:-}" = "si" ] || die "FASE 3 solo con el dueño presente (exporta CAUCE_FASE3_CON_DUENO=si)"
[ "$(id -u)" = 0 ] || die "necesita root (lee $ENV_FILE y reescribe pins)"
[ -r "$ENV_FILE" ] || die "no puedo leer $ENV_FILE"
MCP_DECLARATIONS="$(env_declarations CAUCE_MCP_HUMAN_ENABLED)"
[ "$MCP_DECLARATIONS" -le 1 ] || die "CAUCE_MCP_HUMAN_ENABLED esta duplicado en $ENV_FILE"
MCP_HUMAN_ENABLED=0
if [ "$MCP_DECLARATIONS" -eq 1 ]; then
  MCP_HUMAN_ENABLED="$(env_value CAUCE_MCP_HUMAN_ENABLED)"
fi
[ "$MCP_HUMAN_ENABLED" = 0 ] || [ "$MCP_HUMAN_ENABLED" = 1 ] \
  || die "CAUCE_MCP_HUMAN_ENABLED debe ser 0 o 1 en $ENV_FILE"
if [ "${CAUCE_MCP_HUMAN_ENABLED+x}" = x ] \
   && [ "$CAUCE_MCP_HUMAN_ENABLED" != "$MCP_HUMAN_ENABLED" ]; then
  die "CAUCE_MCP_HUMAN_ENABLED del entorno contradice el archivo de la instancia"
fi
if [ "$MCP_HUMAN_ENABLED" = 1 ]; then
  MCP_NAMES=(CAUCE_MCP_HUMAN_ENABLED CAUCE_MCP_PUBLIC_ORIGIN CAUCE_MCP_OAUTH_ISSUER CAUCE_MCP_OAUTH_JWKS_URI)
  MCP_EXPECTED=("$MCP_HUMAN_ENABLED")
  for name in CAUCE_MCP_PUBLIC_ORIGIN CAUCE_MCP_OAUTH_ISSUER CAUCE_MCP_OAUTH_JWKS_URI; do
    [ "$(env_declarations "$name")" -eq 1 ] \
      || die "$name debe declararse una sola vez en $ENV_FILE"
    value="$(env_value "$name")"
    [[ "$value" =~ [^[:space:]] ]] || die "$name no puede estar vacio en $ENV_FILE"
    if [ "${!name+x}" = x ] && [ "${!name}" != "$value" ]; then
      die "$name del entorno contradice el archivo de la instancia"
    fi
    unset "$name"
    MCP_EXPECTED+=("$value")
  done
  MCP_RENDERED="$(env -u CAUCE_MCP_HUMAN_ENABLED -u CAUCE_MCP_PUBLIC_ORIGIN \
    -u CAUCE_MCP_OAUTH_ISSUER -u CAUCE_MCP_OAUTH_JWKS_URI \
    docker compose --env-file "$ENV_FILE" --project-name cauce-deploy-mcp-config \
      --project-directory "$REPO/deploy" -f - config --format json 2>/dev/null <<'YAML' | python3 -c '
import json, sys
try:
    values = json.load(sys.stdin)["services"]["mcp-config"]["environment"]
    for name in ("CAUCE_MCP_HUMAN_ENABLED", "CAUCE_MCP_PUBLIC_ORIGIN", "CAUCE_MCP_OAUTH_ISSUER", "CAUCE_MCP_OAUTH_JWKS_URI"):
        value = values[name]
        if not isinstance(value, str) or any(character in value for character in "\r\n\0"):
            raise ValueError()
        print(value)
except (ValueError, KeyError, TypeError):
    raise SystemExit(1)
'
services:
  mcp-config:
    image: scratch
    environment:
      CAUCE_MCP_HUMAN_ENABLED: ${CAUCE_MCP_HUMAN_ENABLED-0}
      CAUCE_MCP_PUBLIC_ORIGIN: ${CAUCE_MCP_PUBLIC_ORIGIN-}
      CAUCE_MCP_OAUTH_ISSUER: ${CAUCE_MCP_OAUTH_ISSUER-}
      CAUCE_MCP_OAUTH_JWKS_URI: ${CAUCE_MCP_OAUTH_JWKS_URI-}
YAML
  )" || die "configuracion MCP ambigua o dotenv invalido en $ENV_FILE"
  mapfile -t MCP_VALUES <<< "$MCP_RENDERED"
  for index in 0 1 2 3; do
    [ "${MCP_VALUES[$index]:-}" = "${MCP_EXPECTED[$index]}" ] \
      || die "${MCP_NAMES[$index]} debe ser literal y coincidir con Compose en $ENV_FILE"
  done
  prepare_terminal
  [ -r "$REPO/deploy/compose.mcp-human.yaml" ] || die "no puedo leer deploy/compose.mcp-human.yaml"
  COMPOSE+=(-f "$REPO/deploy/compose.mcp-human.yaml")
  "${COMPOSE[@]}" config >/dev/null || die "el compose MCP no renderiza con $ENV_FILE"
fi
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
BLOB_DECLARATIONS="$(grep -c '^CAUCE_BLOB_API_ENABLED=' "$ENV_FILE" || true)"
[ "$BLOB_DECLARATIONS" -le 1 ] || die "CAUCE_BLOB_API_ENABLED esta duplicado en $ENV_FILE"
if [ "$BLOB_DECLARATIONS" -eq 0 ]; then
  BLOB_API_ENABLED=0
else
  BLOB_API_ENABLED="$(env_value CAUCE_BLOB_API_ENABLED)"
  case "$BLOB_API_ENABLED" in
    0|1) ;;
    *) die "CAUCE_BLOB_API_ENABLED debe ser 0 o 1 en $ENV_FILE" ;;
  esac
fi
if [ "${CAUCE_BLOB_API_ENABLED+x}" = x ] \
   && [ "$CAUCE_BLOB_API_ENABLED" != "$BLOB_API_ENABLED" ]; then
  die "CAUCE_BLOB_API_ENABLED del entorno contradice el archivo de la instancia"
fi
export CAUCE_BLOB_API_ENABLED="$BLOB_API_ENABLED"
BACKUP_BLOB_VOLUME="$(env_value COMPOSE_PROJECT_NAME)"
BACKUP_BLOB_VOLUME="${BACKUP_BLOB_VOLUME:-cauce-v3-prod}_blobs_data"
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
PROJECT_NAME="$(env_value COMPOSE_PROJECT_NAME)"
PROJECT_NAME="${PROJECT_NAME:-cauce-v3-prod}"
[[ "$PROJECT_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "COMPOSE_PROJECT_NAME invalido"
PG_CONTAINER="$PROJECT_NAME-postgres-1"
GATEWAY_CONTAINER="$PROJECT_NAME-gateway-1"
PG_USER="$(env_value POSTGRES_USER)"
PG_DB="$(env_value POSTGRES_DB)"
if [ -z "$PG_USER" ] || [ -z "$PG_DB" ]; then
  die "POSTGRES_USER y POSTGRES_DB deben estar definidos"
fi

check_blob_migration_window() {
  BLOB_MIGRATION_PENDING=0
  [ -f "$REPO/packages/store/migrations/043_blob_tenant_entitlements.sql" ] || return 0
  local containers volumes pg_running applied gateway_running gateway_blob_flag gateway_image compatible_through
  containers="$(docker ps -a --format '{{.Names}}')" \
    || die "no pude enumerar contenedores para comprobar la migracion 043"
  if ! printf '%s\n' "$containers" | grep -Fxq "$PG_CONTAINER"; then
    volumes="$(docker volume ls --format '{{.Name}}')" \
      || die "no pude enumerar volumenes para comprobar la migracion 043"
    if printf '%s\n' "$volumes" | grep -Fxq "${PROJECT_NAME}_cauce_pgdata" \
       || printf '%s\n' "$containers" | grep -Fxq "$GATEWAY_CONTAINER"; then
      die "hay datos o gateway de una instalacion existente sin PostgreSQL inspeccionable; estado de 043 indeterminado"
    fi
    return 0
  fi
  pg_running="$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER")" \
    || die "no pude inspeccionar PostgreSQL existente antes de la migracion 043"
  [ "$pg_running" = true ] || die "PostgreSQL existente no esta activo; estado de la migracion 043 indeterminado"
  applied="$(docker exec "$PG_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" \
    -c "SELECT count(*) FROM schema_migrations WHERE version='043_blob_tenant_entitlements.sql'")" \
    || die "no pude consultar schema_migrations para la migracion 043"
  if [ "$applied" = 0 ]; then
    BLOB_MIGRATION_PENDING=1
  elif [ "$applied" != 1 ]; then
    die "estado ambiguo de la migracion 043: $applied"
  fi
  if [ "$BLOB_MIGRATION_PENDING" = 1 ]; then
    [ "$BLOB_API_ENABLED" = 0 ] \
      || die "la migracion 043 pendiente exige CAUCE_BLOB_API_ENABLED=0 antes del build; desactiva la API en el gateway anterior"
  fi
  if printf '%s\n' "$containers" | grep -Fxq "$GATEWAY_CONTAINER"; then
    gateway_running="$(docker inspect -f '{{.State.Running}}' "$GATEWAY_CONTAINER")" \
      || die "no pude inspeccionar el gateway anterior antes de la migracion 043"
    if [ "$gateway_running" = true ]; then
      gateway_blob_flag="$(docker exec "$GATEWAY_CONTAINER" printenv CAUCE_BLOB_API_ENABLED)" \
        || die "no pude leer el flag de blobs del gateway anterior"
      if [ "$BLOB_MIGRATION_PENDING" = 1 ]; then
        [ "$gateway_blob_flag" = 0 ] \
          || die "el gateway anterior sigue con API de blobs activa o indeterminada; reinicialo con CAUCE_BLOB_API_ENABLED=0 antes de migrar 043"
      elif [ "$gateway_blob_flag" = 1 ]; then
        gateway_image="$(docker inspect -f '{{.Image}}' "$GATEWAY_CONTAINER")" \
          || die "no pude identificar la imagen del gateway vivo con 043 aplicada"
        [[ "$gateway_image" =~ ^sha256:[a-f0-9]{64}$ ]] \
          || die "la imagen del gateway vivo tiene identidad indeterminada con 043 aplicada"
        compatible_through="$(docker image inspect --format '{{index .Config.Labels "io.cauce.schema.compatible-through"}}' "$gateway_image")" \
          || die "no pude inspeccionar la compatibilidad de esquema de la imagen del gateway vivo"
        if [ "$compatible_through" != 043_blob_tenant_entitlements.sql ]; then
          if [[ "$compatible_through" =~ ^([0-9]{3})_[a-z0-9_-]+\.sql$ ]]; then
            (( 10#${BASH_REMATCH[1]} > 43 )) \
              || die "gateway vivo con API de blobs=1 incompatible con 043 aplicada: $compatible_through"
          else
            die "gateway vivo con API de blobs=1 sin label de compatibilidad valido para 043"
          fi
        fi
      elif [ "$gateway_blob_flag" != 0 ]; then
        die "flag de blobs del gateway vivo indeterminado con 043 aplicada"
      fi
    elif [ "$gateway_running" != false ]; then
      die "estado del gateway anterior indeterminado antes de la migracion 043"
    fi
  fi
}
check_blob_migration_window
REQUIRE_BLOB_BACKUP="$BLOB_API_ENABLED"
[ "$BLOB_MIGRATION_PENDING" = 0 ] || REQUIRE_BLOB_BACKUP=1
if [ "$REQUIRE_BLOB_BACKUP" = 1 ]; then
  [ "$BACKUP_MAX_AGE_HOURS" -le 24 ] \
    || die "la API de blobs o migracion 043 exige backup verificado de 24 horas o menos"
fi

echo "== Cauce V3 deploy: commit $REV ($STAMP) =="

if ! STATUS_FILE="$BACKUP_STATUS_FILE" MAX_AGE_HOURS="$BACKUP_MAX_AGE_HOURS" \
  REQUIRE_BLOB_VOLUME="$REQUIRE_BLOB_BACKUP" \
  BLOB_VOLUME="$BACKUP_BLOB_VOLUME" \
  "$BACKUP_MONITOR" >/dev/null; then
  [ "$REQUIRE_BLOB_BACKUP" = 0 ] \
    || die "la API de blobs o migracion 043 exige un backup verificado; no se admite omitir este control"
  echo "AVISO: el estado de backup no acredita una copia sana de <${BACKUP_MAX_AGE_HOURS}h en $BACKUP_STATUS_FILE."
  confirmar "¿Continuar igual?" || die "abortado por falta de backup fresco"
fi
if [ "$REQUIRE_BLOB_BACKUP" = 1 ]; then
  python3 - "$BACKUP_STATUS_FILE" "$BACKUP_BLOB_VOLUME" <<'PY' \
    || die "la API de blobs o migracion 043 exige restauracion de tabla y volumen posterior a la migracion 042"
import json
import pathlib
import sys

try:
    status = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    if status.get("schema_version") == 2:
        dump = pathlib.Path(status["dump_file"])
        evidence_path = status["restore_evidence_file"]
        suite = "hospital-cauce-backup-restore"
    elif status.get("schema_version") == 4:
        dump = pathlib.Path(status["db"]["file"])
        evidence_path = status["restore"]["evidence_file"]
        suite = "cauce-v3-host-backup-restore"
        if status["blobs"]["volume"] != sys.argv[2]:
            raise ValueError("wrong central blob volume")
    else:
        raise ValueError("unknown backup status schema")
    evidence = json.loads(pathlib.Path(evidence_path).read_text(encoding="utf-8"))
    verified = (
        status.get("overall") == "ok"
        and evidence_path == f"{dump}.restore.json"
        and evidence.get("schema_version") == 2
        and evidence.get("suite") == suite
        and evidence.get("dump_file") == dump.name
        and evidence.get("full_restore") is True
        and evidence.get("blob_table_present") is True
        and evidence.get("blob_volume_present") is True
        and evidence.get("blob_restore_verified") is True
    )
except (OSError, ValueError, TypeError, KeyError, AttributeError, json.JSONDecodeError):
    verified = False
if not verified:
    raise SystemExit(1)
PY
fi

# Both images come from deploy/Dockerfile: `runtime` is NOT the last stage (console is), so the
# target is explicit; the console stage bakes the relay instance id into its nginx route at build.
[ "$MCP_HUMAN_ENABLED" = 1 ] || prepare_terminal
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

"${COMPOSE[@]}" config >/dev/null || deployment_failed "el compose canonico no renderiza con $ENV_FILE"

confirmar "¿Migrar hasta $LAST_MIGRATION (bundle de packages/store/migrations, una transaccion) y desplegar $REV?" || die "abortado por el dueño"
check_blob_migration_window
[ "$BLOB_MIGRATION_PENDING" = 0 ] || [ "$REQUIRE_BLOB_BACKUP" = 1 ] \
  || die "043 paso a pendiente despues del backup; repite el deploy con evidencia de tabla y volumen"

# B1 re-checked at the last instant, only while schema 034 is still pending: once applied, open TUIs are normal.
if docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  aplicada_034="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM schema_migrations WHERE version LIKE '034_%'" 2>/dev/null || echo 0)"
  if [ "$aplicada_034" = "0" ]; then
    fantasmas="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL")"
    [ "$fantasmas" = "0" ] || die "hay $fantasmas sesiones de terminal sin anclar: la 034 abortaria (dossier B1: repite el UPDATE y reintenta)"
  fi
else
  echo "PostgreSQL nuevo: la comprobacion de sesiones previas no aplica antes del primer migrator."
fi
"${COMPOSE[@]}" run --rm -T migrator || deployment_failed "migracion fallida; $ENV_FILE apunta a los digests nuevos (runtime=$RUNTIME_DIGEST console=$CONSOLE_DIGEST). Comprueba el esquema antes de restaurar pins anteriores: con 043 aplicada, el gateway viejo con API de blobs=1 es incompatible. Snapshot previo: $ENV_FILE.pre-deploy-$STAMP"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 --remove-orphans || deployment_failed "up fallo; no levantes el gateway anterior con API de blobs=1 si 043 esta aplicada. Para revertir, restaura juntos BD y volumen del snapshot previo a 043, verifica esquema anterior y despues los pins de $ENV_FILE.pre-deploy-$STAMP"
CAUCE_ENV_FILE="$ENV_FILE" "$REPO/deploy/refresh-observability.sh" \
  || deployment_failed "no se pudieron refrescar los bind mounts de observabilidad"
CAUCE_ENV_FILE="$ENV_FILE" "$REPO/deploy/smoke.sh" \
  || deployment_failed "SMOKE ROJO: la BD puede estar en $LAST_MIGRATION. No levantes gateway viejo con API de blobs=1 sobre 043; para revertir, restaura juntos BD y volumen previos a 043, verifica esquema y despues los pins de $ENV_FILE.pre-deploy-$STAMP"

echo "| $STAMP | $REV | $RUNTIME_DIGEST | $CONSOLE_DIGEST | smoke OK |" >> "$HISTORY_FILE"
echo "== deploy $REV COMPLETO. Registra el resultado en $HISTORY_FILE. =="
