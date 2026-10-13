#!/usr/bin/env bash
# Simple Cauce V3 deploy (PHASE 3). Replaces retired machinery (history in git).
# Contract: gates receipt -> build -> migrate with candidate pins -> pin -> up -> smoke -> record.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${CAUCE_ENV_FILE:-/etc/cauce-v3/prod.env}"
REGISTRY="${CAUCE_DEPLOY_REGISTRY:-127.0.0.1:5000}"
EXPECTED_GIT_REF="${CAUCE_DEPLOY_EXPECTED_GIT_REF:-origin/main}"
HISTORY_FILE="${CAUCE_DEPLOY_HISTORY_FILE:-$REPO/deploy/HISTORIAL.md}"
BACKUP_STATUS_FILE="${CAUCE_DEPLOY_BACKUP_STATUS_FILE:-/var/log/cauce-v3-backup/status.json}"
BACKUP_MAX_AGE_HOURS="${CAUCE_DEPLOY_BACKUP_MAX_AGE_HOURS:-24}"
BACKUP_MONITOR="${CAUCE_DEPLOY_BACKUP_MONITOR:-$REPO/ops/scripts/host-backup-monitor.sh}"
GATES_RECEIPT="${CAUCE_DEPLOY_GATES_RECEIPT:-}"
SIN_RECIBO="${CAUCE_DEPLOY_SIN_RECIBO:-}"
MIGRATION_BACKUP_MAX_AGE_HOURS=2
MAX_XACT_SECONDS="${CAUCE_DEPLOY_MAX_XACT_SECONDS:-5}"
MIGRATION_LOCK_TIMEOUT_MS="${CAUCE_MIGRATION_LOCK_TIMEOUT_MS:-}"
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
compose_recipe() {
  local name
  RECIPE=(env)
  if [ "$MCP_HUMAN_ENABLED" = 1 ]; then
    for name in "${MCP_NAMES[@]:1}"; do RECIPE+=(-u "$name"); done
  fi
  RECIPE+=("CAUCE_TERMINAL_RELAY_INSTANCE_ID=$INSTANCE_ID" "CAUCE_BLOB_API_ENABLED=$BLOB_API_ENABLED")
  if [ "$MCP_HUMAN_ENABLED" = 1 ] && [ "$MCP_PROVIDER" = local ]; then
    RECIPE+=("CAUCE_MCP_OAUTH_SIGNING_KEY_PATH=$MCP_SIGNING_KEY_PATH")
  fi
  if [ "$TERMINAL_ENABLED" = 0 ]; then
    RECIPE+=(CAUCE_GATEWAY_RELAY_CLIENT_CERT_PATH=/dev/null CAUCE_GATEWAY_RELAY_CLIENT_KEY_PATH=/dev/null)
  fi
  RECIPE+=("${COMPOSE[@]}")
}
deployment_failed() {
  echo "deploy: $1" >&2
  if [ "$MCP_HUMAN_ENABLED" = 1 ]; then
    compose_recipe
    echo "Rollback MCP manual: solo despues de verificar/restaurar esquema, BD y volumen segun el error; restaura el archivo completo (flag y configuracion incluidos):" >&2
    printf 'cp -a %q %q\n' "$ENV_FILE.pre-deploy-$STAMP" "$ENV_FILE" >&2
    printf '%q ' "${RECIPE[@]}" >&2; printf 'config\n' >&2
    printf '%q ' "${RECIPE[@]}" >&2; printf 'up -d --wait --wait-timeout 300 --remove-orphans\n' >&2
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
MCP_PROVIDER_DECLARATIONS="$(env_declarations CAUCE_MCP_OAUTH_PROVIDER)"
[ "$MCP_PROVIDER_DECLARATIONS" -le 1 ] || die "CAUCE_MCP_OAUTH_PROVIDER esta duplicado en $ENV_FILE"
MCP_PROVIDER=""
[ "$MCP_PROVIDER_DECLARATIONS" -eq 0 ] || MCP_PROVIDER="$(env_value CAUCE_MCP_OAUTH_PROVIDER)"
[ -z "$MCP_PROVIDER" ] || [ "$MCP_PROVIDER" = local ] \
  || die "CAUCE_MCP_OAUTH_PROVIDER solo admite 'local' o ausente (modo externo) en $ENV_FILE"
if [ "${CAUCE_MCP_OAUTH_PROVIDER+x}" = x ] \
   && [ "$CAUCE_MCP_OAUTH_PROVIDER" != "$MCP_PROVIDER" ]; then
  die "CAUCE_MCP_OAUTH_PROVIDER del entorno contradice el archivo de la instancia"
fi
MCP_SIGNING_KEY_PATH=""
if [ "$MCP_HUMAN_ENABLED" = 1 ] && [ "$MCP_PROVIDER" = local ]; then
  MCP_OVERLAY_NAME=compose.mcp-human-local.yaml
  for name in CAUCE_MCP_OAUTH_ISSUER CAUCE_MCP_OAUTH_JWKS_URI; do
    [ "$(env_declarations "$name")" -eq 0 ] \
      || die "$name no se admite con CAUCE_MCP_OAUTH_PROVIDER=local en $ENV_FILE"
    [ "${!name+x}" != x ] \
      || die "$name del entorno no se admite con CAUCE_MCP_OAUTH_PROVIDER=local"
  done
  AUTH_PROVIDER_DECLARATIONS="$(env_declarations CAUCE_AUTH_PROVIDER)"
  [ "$AUTH_PROVIDER_DECLARATIONS" -le 1 ] || die "CAUCE_AUTH_PROVIDER esta duplicado en $ENV_FILE"
  AUTH_PROVIDER=""
  [ "$AUTH_PROVIDER_DECLARATIONS" -eq 0 ] || AUTH_PROVIDER="$(env_value CAUCE_AUTH_PROVIDER)"
  if [ "${CAUCE_AUTH_PROVIDER+x}" = x ]; then
    [ -z "$AUTH_PROVIDER" ] || [ "$CAUCE_AUTH_PROVIDER" = "$AUTH_PROVIDER" ] \
      || die "CAUCE_AUTH_PROVIDER del entorno contradice el archivo de la instancia"
    AUTH_PROVIDER="$CAUCE_AUTH_PROVIDER"
  fi
  [ "$AUTH_PROVIDER" = password ] \
    || die "CAUCE_MCP_OAUTH_PROVIDER=local exige CAUCE_AUTH_PROVIDER=password"
  MCP_SIGNING_KEY_PATH="${CAUCE_MCP_OAUTH_SIGNING_KEY_PATH:-}"
  [ -n "$MCP_SIGNING_KEY_PATH" ] \
    || die "exporta CAUCE_MCP_OAUTH_SIGNING_KEY_PATH con la ruta de la clave de firma"
  MCP_NAMES=(CAUCE_MCP_HUMAN_ENABLED CAUCE_MCP_OAUTH_PROVIDER CAUCE_MCP_PUBLIC_ORIGIN CAUCE_MCP_OAUTH_SIGNING_KID)
  MCP_EXPECTED=("$MCP_HUMAN_ENABLED" local)
  for name in CAUCE_MCP_PUBLIC_ORIGIN CAUCE_MCP_OAUTH_SIGNING_KID; do
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
  MCP_RENDERED="$(env -u CAUCE_MCP_HUMAN_ENABLED -u CAUCE_MCP_OAUTH_PROVIDER -u CAUCE_MCP_PUBLIC_ORIGIN -u CAUCE_MCP_OAUTH_SIGNING_KID \
    docker compose --env-file "$ENV_FILE" --project-name cauce-deploy-mcp-config \
      --project-directory "$REPO/deploy" -f - config --format json 2>/dev/null <<'YAML' | python3 -c '
import json, sys
try:
    values = json.load(sys.stdin)["services"]["mcp-config"]["environment"]
    for name in ("CAUCE_MCP_HUMAN_ENABLED", "CAUCE_MCP_OAUTH_PROVIDER", "CAUCE_MCP_PUBLIC_ORIGIN", "CAUCE_MCP_OAUTH_SIGNING_KID"):
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
      CAUCE_MCP_OAUTH_PROVIDER: ${CAUCE_MCP_OAUTH_PROVIDER-}
      CAUCE_MCP_PUBLIC_ORIGIN: ${CAUCE_MCP_PUBLIC_ORIGIN-}
      CAUCE_MCP_OAUTH_SIGNING_KID: ${CAUCE_MCP_OAUTH_SIGNING_KID-}
YAML
  )" || die "configuracion MCP ambigua o dotenv invalido en $ENV_FILE"
elif [ "$MCP_HUMAN_ENABLED" = 1 ]; then
  MCP_OVERLAY_NAME=compose.mcp-human.yaml
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
fi
if [ "$MCP_HUMAN_ENABLED" = 1 ]; then
  mapfile -t MCP_VALUES <<< "$MCP_RENDERED"
  for index in "${!MCP_NAMES[@]}"; do
    [ "${MCP_VALUES[$index]:-}" = "${MCP_EXPECTED[$index]}" ] \
      || die "${MCP_NAMES[$index]} debe ser literal y coincidir con Compose en $ENV_FILE"
  done
  prepare_terminal
  [ -r "$REPO/deploy/$MCP_OVERLAY_NAME" ] || die "no puedo leer deploy/$MCP_OVERLAY_NAME"
  COMPOSE+=(-f "$REPO/deploy/$MCP_OVERLAY_NAME")
  "${COMPOSE[@]}" config >/dev/null || die "el compose MCP no renderiza con $ENV_FILE"
fi
FLEET_OVERLAY="$(env_value CAUCE_DEPLOY_FLEET_OVERLAY)"
[ -z "$FLEET_OVERLAY" ] || [ "$FLEET_OVERLAY" = 0 ] || [ "$FLEET_OVERLAY" = 1 ] \
  || die "CAUCE_DEPLOY_FLEET_OVERLAY debe ser 0 o 1 en $ENV_FILE"
if [ "$FLEET_OVERLAY" = 1 ]; then
  systemctl is-active --quiet cauce-fleet-v35-controller.service \
    || die "CAUCE_DEPLOY_FLEET_OVERLAY=1 exige cauce-fleet-v35-controller activo antes de recrear el gateway"
  COMPOSE+=(-f "$REPO/deploy/compose.fleet.yaml")
  "${COMPOSE[@]}" config >/dev/null || die "el compose de flota no renderiza con $ENV_FILE"
fi
OWNER_DATABASE_URL="$(env_value CAUCE_DATABASE_URL_SECRET_PATH)"
for service in GATEWAY DISPATCHER BRIDGE OBSERVER; do
  name="CAUCE_DATABASE_URL_${service}_SECRET_PATH"
  [ "$(env_declarations "$name")" -le 1 ] || die "$name esta duplicado en $ENV_FILE"
  value="$(env_value "$name")"
  if [ "${!name+x}" = x ] && [ "${!name}" != "$value" ]; then
    die "$name del entorno contradice el archivo de la instancia"
  fi
  if [ -z "$value" ] || [ "$value" = "$OWNER_DATABASE_URL" ]; then
    echo "AVISO: runtime con superusuario: ${service,,} usa el secreto del migrador (falta $name; ver docs/runbook-rol-runtime.md)" >&2
  elif [ ! -f "$value" ] || [ ! -r "$value" ]; then
    die "$name no apunta a un fichero legible ($value)"
  fi
done
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
[[ "$MAX_XACT_SECONDS" =~ ^[1-9][0-9]{0,3}$ ]] || die "CAUCE_DEPLOY_MAX_XACT_SECONDS debe ser un entero entre 1 y 9999"
[ -z "$MIGRATION_LOCK_TIMEOUT_MS" ] || [[ "$MIGRATION_LOCK_TIMEOUT_MS" =~ ^[1-9][0-9]{0,4}$ && "$MIGRATION_LOCK_TIMEOUT_MS" -le 60000 ]] \
  || die "CAUCE_MIGRATION_LOCK_TIMEOUT_MS debe ser un entero de milisegundos entre 1 y 60000"
[ -d "$(dirname "$HISTORY_FILE")" ] || die "no existe el directorio de historial $(dirname "$HISTORY_FILE")"
[ ! -L "$HISTORY_FILE" ] || die "CAUCE_DEPLOY_HISTORY_FILE no puede ser un symlink"
for name in CAUCE_RUNTIME_IMAGE CAUCE_CONSOLE_IMAGE; do
  [ "${!name+x}" != x ] || die "$name del entorno anularia el pin de $ENV_FILE; quitalo del entorno"
  if [ "$(env_declarations "$name")" != 1 ] || ! grep -q "^$name=" "$ENV_FILE"; then
    die "$name debe declararse una sola vez como $name=... en $ENV_FILE"
  fi
done
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
if [ "${CAUCE_DEPLOY_PRINT_COMPOSE:-0}" = 1 ]; then
  [ "$MCP_HUMAN_ENABLED" = 1 ] || prepare_terminal
  compose_recipe
  printf '%q ' "${RECIPE[@]}"; printf '\n'
  exit 0
fi
if [ -n "$SIN_RECIBO" ]; then
  [ -z "$GATES_RECEIPT" ] || die "CAUCE_DEPLOY_GATES_RECEIPT y CAUCE_DEPLOY_SIN_RECIBO son excluyentes"
  [[ "$SIN_RECIBO" =~ ^[^|[:cntrl:]]{1,200}$ && "$SIN_RECIBO" =~ [^[:space:]] ]] \
    || die "CAUCE_DEPLOY_SIN_RECIBO debe ser un motivo de una linea, sin '|' y de 200 caracteres o menos"
else
  [[ "$GATES_RECEIPT" = /* ]] \
    || die "falta el recibo de gates: exporta CAUCE_DEPLOY_GATES_RECEIPT con la ruta absoluta del recibo de scripts/release-gates.sh (escape auditado: CAUCE_DEPLOY_SIN_RECIBO=motivo)"
  [ -f "$GATES_RECEIPT" ] || die "no encuentro el recibo de gates $GATES_RECEIPT"
fi
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
RELEASE_COMMIT="$(git rev-parse HEAD)"
if [ -n "$SIN_RECIBO" ]; then
  echo "AVISO: despliegue de $REV SIN recibo de gates; motivo (queda en $HISTORY_FILE): $SIN_RECIBO" >&2
  confirmar "¿Desplegar $REV sin recibo de gates?" || die "abortado: falta el recibo de gates"
  GATES_EVIDENCE="SIN RECIBO DE GATES: $SIN_RECIBO"
else
  RELEASE_TREE="$(git rev-parse 'HEAD^{tree}')"
  EXPECTED_GATES="$(bash "$REPO/scripts/release-gates.sh" --list)" \
    || die "no pude listar los gates de scripts/release-gates.sh"
  GATES_RECEIPT_SHA256="$(python3 - "$GATES_RECEIPT" "$RELEASE_COMMIT" "$RELEASE_TREE" "$EXPECTED_GATES" <<'PY'
import hashlib
import json
import re
import sys

path, commit, tree, expected = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].splitlines()
try:
    with open(path, "rb") as handle:
        raw = handle.read()
    receipt = json.loads(raw)
    commands = receipt["comandos"]
    problems = []
    if receipt["commit"] != commit:
        problems.append(f"commit del recibo {receipt['commit']} != HEAD {commit}")
    if receipt["tree"] != tree:
        problems.append(f"tree del recibo {receipt['tree']} != HEAD^{{tree}} {tree}")
    if [command["cmd"] for command in commands] != expected:
        problems.append("los comandos del recibo no son los de scripts/release-gates.sh --list en orden")
    for command in commands:
        if type(command["exit"]) is not int or command["exit"] != 0:
            problems.append(f"{command['cmd']}: exit {command['exit']}")
        if not re.fullmatch(r"[0-9a-f]{64}", str(command["log_sha256"])):
            problems.append(f"{command['cmd']}: log_sha256 invalido")
        if type(command["duracion"]) not in (int, float) or command["duracion"] < 0:
            problems.append(f"{command['cmd']}: duracion invalida")
    if not all(isinstance(receipt[key], str) and receipt[key] for key in ("inicio", "fin")):
        problems.append("inicio o fin ausentes")
except (OSError, ValueError, TypeError, KeyError) as error:
    problems = [f"recibo ilegible: {error!r}"]
if problems:
    print("\n".join(problems), file=sys.stderr)
    raise SystemExit(1)
print(hashlib.sha256(raw).hexdigest())
PY
  )" || die "el recibo de gates $GATES_RECEIPT no acredita un gate verde de $RELEASE_COMMIT"
  GATES_EVIDENCE="recibo de gates sha256:$GATES_RECEIPT_SHA256"
fi
RUNTIME_SOURCE_DIGEST="$(python3 ops/scripts/source-digest.py --domain runtime)"
CONSOLE_SOURCE_DIGEST="$(python3 ops/scripts/source-digest.py --domain console)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUNTIME_TAG="$REGISTRY/cauce-v3-runtime:$REV"
CONSOLE_TAG="$REGISTRY/cauce-v3-console:$REV"
BUNDLED_MIGRATIONS="$(find "$REPO/packages/store/migrations" -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -printf '%f\n' | LC_ALL=C sort)"
LAST_MIGRATION="$(printf '%s\n' "$BUNDLED_MIGRATIONS" | sort -V | tail -1)" # never hardcode this: derive from what is actually bundled
[ -n "$LAST_MIGRATION" ] || die "no encuentro migraciones en packages/store/migrations"
PROJECT_NAME="$(env_value COMPOSE_PROJECT_NAME)"
PROJECT_NAME="${PROJECT_NAME:-cauce-v3-prod}"
[[ "$PROJECT_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "COMPOSE_PROJECT_NAME invalido"
PG_CONTAINER="$PROJECT_NAME-postgres-1"
GATEWAY_CONTAINER="$PROJECT_NAME-gateway-1"
DISPATCHER_CONTAINER="$PROJECT_NAME-dispatcher-1"
PG_USER="$(env_value POSTGRES_USER)"
PG_DB="$(env_value POSTGRES_DB)"
if [ -z "$PG_USER" ] || [ -z "$PG_DB" ]; then
  die "POSTGRES_USER y POSTGRES_DB deben estar definidos"
fi

[ "$MCP_HUMAN_ENABLED" = 1 ] || prepare_terminal
COMPOSE_MODEL="$("${COMPOSE[@]}" config --format json)" \
  || die "no pude renderizar el compose con $ENV_FILE para comprobar las fuentes de los bind mounts"
if [ "$FLEET_OVERLAY" = 1 ]; then
  fleet_mounts="$(python3 -c '
import json, sys
volumes = json.load(sys.stdin).get("services", {}).get("gateway", {}).get("volumes", [])
for target in ("/run/cauce-fleet/config", "/run/cauce-fleet-signed-authority"):
    sources = [mount.get("source") for mount in volumes
               if mount.get("type") == "bind" and mount.get("target") == target]
    if len(sources) != 1 or not isinstance(sources[0], str) or any(char in sources[0] for char in "\r\n\0"):
        raise SystemExit(1)
    print(sources[0])
' <<< "$COMPOSE_MODEL")" || die "el compose debe montar una unica fuente bind para gateway y enclave de flota"
  mapfile -t fleet_sources <<< "$fleet_mounts"
  fleet_gateway=${CAUCE_DEPLOY_FLEET_GATEWAY_DIR:-/etc/cauce-v3/fleet-v35/gateway}
  fleet_enclave=${CAUCE_DEPLOY_FLEET_ENCLAVE_DIR:-/run/cauce-fleet-signed-authority}
  printf 'flota: compruebo gateway %s (compose: %s)\n' "$fleet_gateway" "${fleet_sources[0]}"
  printf 'flota: compruebo enclave %s (compose: %s)\n' "$fleet_enclave" "${fleet_sources[1]}"
  [ "$fleet_gateway" = "${fleet_sources[0]}" ] \
    || die "CAUCE_DEPLOY_FLEET_GATEWAY_DIR=$fleet_gateway difiere del montaje de compose ${fleet_sources[0]}"
  [ "$fleet_enclave" = "${fleet_sources[1]}" ] \
    || die "CAUCE_DEPLOY_FLEET_ENCLAVE_DIR=$fleet_enclave difiere del montaje de compose ${fleet_sources[1]}"
fi
MISSING_BIND_SOURCES="$(python3 -c '
import json, os, sys
model = json.load(sys.stdin)
sources = [(name, mount["source"]) for name, service in model.get("services", {}).items()
           for mount in service.get("volumes", []) if mount.get("type") == "bind"]
sources += [(f"{kind}.{name}", item["file"]) for kind in ("secrets", "configs")
            for name, item in model.get(kind, {}).items() if "file" in item]
for owner, source in sorted(set(sources)):
    if not os.path.exists(source):
        print(f"{owner}: {source}")
' <<< "$COMPOSE_MODEL")" || die "no pude comprobar las fuentes de los bind mounts del compose con $ENV_FILE"
[ -z "$MISSING_BIND_SOURCES" ] \
  || die "faltan fuentes de bind mounts del compose; no se construye nada:"$'\n'"$MISSING_BIND_SOURCES"

if [ "$FLEET_OVERLAY" = 1 ]; then
  [ -d "$fleet_gateway" ] || die "falta $fleet_gateway antes de construir"
  gateway_meta=$(stat -c '%u %a' "$fleet_gateway") || die "no pude leer el modo de $fleet_gateway; no se construye"
  [ "$gateway_meta" = "1000 700" ] || die "el directorio $fleet_gateway debe ser uid 1000 y modo 0700 (es $gateway_meta); no se construye"
  for fleet_file in "$fleet_gateway/api.v1.json" "$fleet_gateway/capability.v1.json"; do
    [ -f "$fleet_file" ] || die "falta $fleet_file antes de construir"
    file_meta=$(stat -c '%u %a' "$fleet_file") || die "no pude leer el modo de $fleet_file; no se construye"
    [ "$file_meta" = "1000 600" ] || die "el fichero $fleet_file debe ser uid 1000 y modo 0600 (es $file_meta); no se construye"
  done
  [ -d "$fleet_enclave" ] || die "falta $fleet_enclave antes de construir"
  enclave_meta=$(stat -c '%u %g %a' "$fleet_enclave") || die "no pude leer el modo de $fleet_enclave; no se construye"
  [ "$enclave_meta" = "0 1000 750" ] || die "el directorio $fleet_enclave debe ser root:1000 y modo 0750 (es $enclave_meta); no se construye"
fi

count_unapplied_migrations() {
  local applied unapplied pending rc=0
  applied="$(printf '%s\n' "$1" | LC_ALL=C sort)" || die "no pude ordenar migraciones aplicadas"
  unapplied="$(LC_ALL=C comm -23 <(printf '%s\n' "$BUNDLED_MIGRATIONS") \
    <(printf '%s\n' "$applied"))" || die "no pude comparar migraciones aplicadas con el bundle"
  pending="$(printf '%s\n' "$unapplied" | grep -c .)" || rc=$?
  [ "$rc" -le 1 ] || die "no pude contar migraciones pendientes"
  [[ $pending =~ ^[0-9]+$ ]] || die "recuento de migraciones pendientes invalido"
  printf '%s\n' "$pending"
}
count_pending_migrations() {
  PENDING_MIGRATIONS=0
  MIGRATION_ATTEMPT_PENDING="$(count_unapplied_migrations '')" || die "no pude contar migraciones del bundle"
  local containers volumes pg_running applied rc
  containers="$(docker ps -a --format '{{.Names}}')" \
    || die "no pude enumerar contenedores para contar migraciones pendientes"
  rc=0
  grep -Fxq "$PG_CONTAINER" <<< "$containers" || rc=$?
  [ "$rc" -le 1 ] || die "no pude buscar PostgreSQL en el inventario de contenedores para contar migraciones pendientes"
  if [ "$rc" = 1 ]; then
    volumes="$(docker volume ls --format '{{.Name}}')" \
      || die "no pude enumerar volumenes para contar migraciones pendientes"
    rc=0
    grep -Fxq "${PROJECT_NAME}_cauce_pgdata" <<< "$volumes" || rc=$?
    [ "$rc" -le 1 ] || die "no pude buscar datos de PostgreSQL en el inventario de volumenes para contar migraciones pendientes"
    if [ "$rc" = 0 ]; then
      die "hay datos de PostgreSQL sin contenedor inspeccionable; migraciones pendientes indeterminadas"
    fi
    return 0
  fi
  pg_running="$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER")" \
    || die "no pude inspeccionar PostgreSQL para contar migraciones pendientes"
  [ "$pg_running" = true ] || die "PostgreSQL existente no esta activo; migraciones pendientes indeterminadas"
  applied="$(docker exec "$PG_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" \
    -c 'SELECT version FROM schema_migrations')" \
    || die "no pude consultar schema_migrations para contar migraciones pendientes"
  PENDING_MIGRATIONS="$(count_unapplied_migrations "$applied")" || die "no pude contar migraciones pendientes"
  [[ $PENDING_MIGRATIONS =~ ^[0-9]+$ ]] || die "recuento de migraciones pendientes invalido"
  MIGRATION_ATTEMPT_PENDING="$PENDING_MIGRATIONS"
}
backup_monitor_accepts() {
  STATUS_FILE="$BACKUP_STATUS_FILE" MAX_AGE_HOURS="$BACKUP_MAX_AGE_HOURS" \
    REQUIRE_BLOB_VOLUME="$REQUIRE_BLOB_BACKUP" \
    BLOB_VOLUME="$BACKUP_BLOB_VOLUME" \
    "$BACKUP_MONITOR" >/dev/null
}
DISPATCHER_STOPPED=0
pause_dispatcher() {
  [ "$(docker inspect -f '{{.State.Running}}' "$DISPATCHER_CONTAINER" 2>/dev/null)" = true ] || return 0
  DISPATCHER_STOPPED=1
  docker stop "$DISPATCHER_CONTAINER" >/dev/null || die "no pude parar $DISPATCHER_CONTAINER antes de migrar"
}
resume_dispatcher() {
  [ "$DISPATCHER_STOPPED" = 1 ] || return 0
  DISPATCHER_STOPPED=0
  docker start "$DISPATCHER_CONTAINER" >/dev/null \
    || echo "deploy: AVISO: no pude reanudar $DISPATCHER_CONTAINER; arrancalo a mano (docker start $DISPATCHER_CONTAINER)" >&2
}
blocking_sessions() {
  docker exec "$PG_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c "
    SELECT format('pid=%s aplicacion=%s estado=%s transaccion=%ss', pid, COALESCE(NULLIF(application_name,''),'-'),
      state, floor(extract(epoch FROM now()-xact_start))::bigint)
    FROM pg_stat_activity
    WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()
      AND xact_start IS NOT NULL
      AND ((state LIKE 'idle in transaction%' AND now()-state_change>interval '1 second')
        OR now()-xact_start>interval '$MAX_XACT_SECONDS seconds')
    ORDER BY xact_start"
}
MIGRATOR_RUNNING=0
terminate_migrator() {
  MIGRATOR_RUNNING=0
  docker exec "$PG_CONTAINER" psql -XAtq -U "$PG_USER" -d "$PG_DB" -c "
    SELECT count(pg_terminate_backend(pid,5000)) FROM pg_stat_activity
    WHERE datname=current_database() AND application_name='cauce-migrator' AND pid<>pg_backend_pid()" >/dev/null \
    || echo "deploy: AVISO: no pude terminar el backend del migrator; revisa pg_stat_activity (application_name=cauce-migrator)" >&2
}

check_blob_migration_window() {
  BLOB_MIGRATION_PENDING=0
  [ -f "$REPO/packages/store/migrations/043_blob_tenant_entitlements.sql" ] || return 0
  local containers volumes pg_running applied gateway_running gateway_blob_flag gateway_image compatible_through rc gateway_rc
  containers="$(docker ps -a --format '{{.Names}}')" \
    || die "no pude enumerar contenedores para comprobar la migracion 043"
  rc=0
  grep -Fxq "$PG_CONTAINER" <<< "$containers" || rc=$?
  [ "$rc" -le 1 ] || die "no pude buscar PostgreSQL en el inventario de contenedores para comprobar la migracion 043"
  gateway_rc=0
  grep -Fxq "$GATEWAY_CONTAINER" <<< "$containers" || gateway_rc=$?
  [ "$gateway_rc" -le 1 ] || die "no pude buscar el gateway en el inventario de contenedores para comprobar la migracion 043"
  if [ "$rc" = 1 ]; then
    volumes="$(docker volume ls --format '{{.Name}}')" \
      || die "no pude enumerar volumenes para comprobar la migracion 043"
    rc=0
    grep -Fxq "${PROJECT_NAME}_cauce_pgdata" <<< "$volumes" || rc=$?
    [ "$rc" -le 1 ] || die "no pude buscar datos de PostgreSQL en el inventario de volumenes para comprobar la migracion 043"
    if [ "$rc" = 0 ] || [ "$gateway_rc" = 0 ]; then
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
  if [ "$gateway_rc" = 0 ]; then
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
count_pending_migrations
MIGRATION_BACKUP_REQUIRED=0
if [ "$PENDING_MIGRATIONS" -gt 0 ]; then
  MIGRATION_BACKUP_REQUIRED=1
  [ "$BACKUP_MAX_AGE_HOURS" -le "$MIGRATION_BACKUP_MAX_AGE_HOURS" ] || BACKUP_MAX_AGE_HOURS="$MIGRATION_BACKUP_MAX_AGE_HOURS"
  echo "$PENDING_MIGRATIONS migraciones pendientes: se exige backup verificado de ${BACKUP_MAX_AGE_HOURS} h o menos"
fi

echo "== Cauce V3 deploy: commit $REV ($STAMP) =="

if ! backup_monitor_accepts; then
  [ "$REQUIRE_BLOB_BACKUP" = 0 ] \
    || die "la API de blobs o migracion 043 exige un backup verificado; no se admite omitir este control"
  [ "$MIGRATION_BACKUP_REQUIRED" = 0 ] \
    || die "hay $PENDING_MIGRATIONS migraciones pendientes y $BACKUP_STATUS_FILE no acredita un backup verificado de ${BACKUP_MAX_AGE_HOURS} h o menos; respalda y repite"
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
docker build -f deploy/Dockerfile --target runtime --build-arg "CAUCE_SCHEMA_COMPATIBLE_THROUGH=$LAST_MIGRATION" --build-arg "CAUCE_SOURCE_DIGEST=$RUNTIME_SOURCE_DIGEST" --build-arg "CAUCE_RELEASE_COMMIT=$RELEASE_COMMIT" -t "$RUNTIME_TAG" .
docker build -f deploy/Dockerfile --target console --build-arg "CAUCE_TERMINAL_RELAY_INSTANCE_ID=$INSTANCE_ID" --build-arg "CAUCE_FRONT_PROXY_CIDR=$(env_value CAUCE_FRONT_PROXY_CIDR)" \
  --build-arg "CAUCE_SOURCE_DIGEST=$CONSOLE_SOURCE_DIGEST" --build-arg "CAUCE_RELEASE_COMMIT=$RELEASE_COMMIT" -t "$CONSOLE_TAG" .
[ "$(docker inspect --format '{{index .Config.Labels "io.cauce.terminal-relay.instance-id"}}' "$CONSOLE_TAG")" = "$INSTANCE_ID" ] \
  || die "la imagen de consola no lleva el instance id horneado"
docker push -q "$RUNTIME_TAG" && docker push -q "$CONSOLE_TAG"
RUNTIME_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$RUNTIME_TAG")"
CONSOLE_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$CONSOLE_TAG")"
echo "runtime: $RUNTIME_DIGEST"
echo "console: $CONSOLE_DIGEST"

CANDIDATE_ENV_FILE="$ENV_FILE.candidate-$STAMP"
trap '[ "$MIGRATOR_RUNNING" = 0 ] || terminate_migrator; resume_dispatcher; rm -f -- "$CANDIDATE_ENV_FILE"' EXIT
cp -a "$ENV_FILE" "$CANDIDATE_ENV_FILE"
sed -i "s|^CAUCE_RUNTIME_IMAGE=.*|CAUCE_RUNTIME_IMAGE=$RUNTIME_DIGEST|" "$CANDIDATE_ENV_FILE"
sed -i "s|^CAUCE_CONSOLE_IMAGE=.*|CAUCE_CONSOLE_IMAGE=$CONSOLE_DIGEST|" "$CANDIDATE_ENV_FILE"
CANDIDATE_COMPOSE=(docker compose --env-file "$CANDIDATE_ENV_FILE" "${COMPOSE[@]:4}")

"${CANDIDATE_COMPOSE[@]}" config >/dev/null || die "el compose con los pins nuevos no renderiza; $ENV_FILE sigue intacto"

confirmar "¿Migrar hasta $LAST_MIGRATION (bundle de packages/store/migrations, una transaccion) y desplegar $REV?" || die "abortado por el dueño; $ENV_FILE sigue intacto"
check_blob_migration_window
[ "$BLOB_MIGRATION_PENDING" = 0 ] || [ "$REQUIRE_BLOB_BACKUP" = 1 ] \
  || die "043 paso a pendiente despues del backup; repite el deploy con evidencia de tabla y volumen"
count_pending_migrations
if [ "$PENDING_MIGRATIONS" -gt 0 ]; then
  [ "$MIGRATION_BACKUP_REQUIRED" = 1 ] \
    || die "aparecieron $PENDING_MIGRATIONS migraciones pendientes despues de comprobar el backup; respalda y repite"
  backup_monitor_accepts \
    || die "el backup ya no tiene ${BACKUP_MAX_AGE_HOURS} h o menos al migrar; respalda y repite"
  pause_dispatcher
  BLOCKING_SESSIONS="$(blocking_sessions)" || die "no pude leer pg_stat_activity antes de migrar"
  [ -z "$BLOCKING_SESSIONS" ] \
    || die "sesiones con una transaccion abierta (idle in transaction >1 s o de mas de ${MAX_XACT_SECONDS} s) que el migrator esperaria con las tablas bloqueadas; no se migro nada. Terminalas o espera a que acaben y repite:"$'\n'"$BLOCKING_SESSIONS"
fi

MIGRATOR_ENV=()
[ -z "$MIGRATION_LOCK_TIMEOUT_MS" ] || MIGRATOR_ENV=(-e "CAUCE_MIGRATION_LOCK_TIMEOUT_MS=$MIGRATION_LOCK_TIMEOUT_MS")
MIGRATOR_RUNNING=1
if ! "${CANDIDATE_COMPOSE[@]}" run --rm -T "${MIGRATOR_ENV[@]}" migrator; then
  terminate_migrator
  if applied_now="$(docker exec "$PG_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" \
      -c 'SELECT version FROM schema_migrations' 2>/dev/null)"; then
    pending_now="$(count_unapplied_migrations "$applied_now")" || pending_now=indeterminado
    if [ "$pending_now" = indeterminado ]; then
      migration_state="indeterminado: no pude contar migraciones pendientes tras el fallo"
    elif [ "$pending_now" = 0 ]; then
      migration_state="todas aplicadas; repite deploy.sh para fijar pins"
    elif [ "$pending_now" = "$MIGRATION_ATTEMPT_PENDING" ]; then
      migration_state="nada aplicado"
    else
      migration_state="parcial: aplicadas $((MIGRATION_ATTEMPT_PENDING - pending_now)) de $MIGRATION_ATTEMPT_PENDING"
    fi
  else
    migration_state="no pude leer schema_migrations"
  fi
  die "migracion fallida: $ENV_FILE sigue con los pins anteriores; $migration_state"
fi
MIGRATOR_RUNNING=0
resume_dispatcher
cp -a "$ENV_FILE" "$ENV_FILE.pre-deploy-$STAMP" \
  || die "no pude guardar $ENV_FILE.pre-deploy-$STAMP; la BD ya esta en $LAST_MIGRATION y $ENV_FILE sigue con los pins anteriores"
mv -f "$CANDIDATE_ENV_FILE" "$ENV_FILE" \
  || die "no pude instalar los pins nuevos en $ENV_FILE; la BD ya esta en $LAST_MIGRATION y $ENV_FILE sigue con los pins anteriores"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 --remove-orphans || deployment_failed "up fallo; no levantes el gateway anterior con API de blobs=1 si 043 esta aplicada. Para revertir, restaura juntos BD y volumen del snapshot previo a 043, verifica esquema anterior y despues los pins de $ENV_FILE.pre-deploy-$STAMP"
CAUCE_ENV_FILE="$ENV_FILE" "$REPO/deploy/refresh-observability.sh" \
  || deployment_failed "no se pudieron refrescar los bind mounts de observabilidad"
CAUCE_ENV_FILE="$ENV_FILE" "$REPO/deploy/smoke.sh" \
  || deployment_failed "SMOKE ROJO: la BD puede estar en $LAST_MIGRATION. No levantes gateway viejo con API de blobs=1 sobre 043; para revertir, restaura juntos BD y volumen previos a 043, verifica esquema y despues los pins de $ENV_FILE.pre-deploy-$STAMP"

echo "| $STAMP | $REV | $RUNTIME_DIGEST | $CONSOLE_DIGEST | smoke OK; $GATES_EVIDENCE |" >> "$HISTORY_FILE"
echo "== deploy $REV COMPLETO. Registra el resultado en $HISTORY_FILE. =="
