#!/usr/bin/env bash
# Simple Cauce V3 deploy (PHASE 3). Replaces retired machinery (history in git).
# Contract: build -> pin by digest -> migrate -> up -> smoke -> record. All or rollback.
# Owner MUST be present: requires CAUCE_FASE3_CON_DUENO=si.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${CAUCE_ENV_FILE:-/etc/cauce-v3/prod.env}"
REGISTRY="127.0.0.1:5000"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$REPO/deploy/compose.yaml" -f "$REPO/deploy/compose.postgres.yaml" --project-directory "$REPO/deploy")

die() { echo "deploy: $*" >&2; exit 1; }
# Prompts are skipped only when the owner pre-authorised the run (CAUCE_DEPLOY_CONFIRMADO=si).
confirmar() {
  if [ "${CAUCE_DEPLOY_CONFIRMADO:-}" = "si" ]; then echo "confirmado por el dueño (entorno): $1"; return 0; fi
  read -r -p "$1 (si/NO) " ok; [ "$ok" = "si" ]
}

[ "${CAUCE_FASE3_CON_DUENO:-}" = "si" ] || die "FASE 3 solo con el dueño presente (exporta CAUCE_FASE3_CON_DUENO=si)"
[ "$(id -u)" = 0 ] || die "necesita root (lee $ENV_FILE y reescribe pins)"
[ -r "$ENV_FILE" ] || die "no puedo leer $ENV_FILE"
cd "$REPO"
[ -z "$(git status --porcelain)" ] || die "el arbol no esta limpio; commitea o descarta antes de desplegar"
git fetch -q origin && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "HEAD != origin/main; sincroniza primero"

REV="$(git rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUNTIME_TAG="$REGISTRY/cauce-v3-runtime:$REV"
CONSOLE_TAG="$REGISTRY/cauce-v3-console:$REV"

echo "== Cauce V3 deploy: commit $REV ($STAMP) =="

if ! find /var/backups -name "*cauce*" -mmin -1440 2>/dev/null | grep -q .; then
  echo "AVISO: no veo backup de <24h en /var/backups; confirma que cauce-v3-db-backup corrio hoy."
  confirmar "¿Continuar igual?" || die "abortado por falta de backup fresco"
fi

# Both images come from deploy/Dockerfile: `runtime` is NOT the last stage (console is), so the
# target is explicit; the console stage bakes the relay instance id into its nginx route at build.
INSTANCE_ID="$(sed -n 's/^CAUCE_TERMINAL_RELAY_INSTANCE_ID=//p' "$ENV_FILE" | tail -1)"
[[ $INSTANCE_ID =~ ^[0-9a-f]{64}$ ]] || die "CAUCE_TERMINAL_RELAY_INSTANCE_ID ausente o invalido en $ENV_FILE (dossier B2)"
# The relay refuses to start unless the pin equals the DER digest of the client cert it presents to the gateway.
CLIENT_CERT="$(sed -n 's/^CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH=//p' "$ENV_FILE" | tail -1)"
[ -r "$CLIENT_CERT" ] || die "no puedo leer CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH ($CLIENT_CERT)"
[ "$(openssl x509 -in "$CLIENT_CERT" -outform DER | sha256sum | awk '{print $1}')" = "$INSTANCE_ID" ] \
  || die "CAUCE_TERMINAL_RELAY_INSTANCE_ID no es el sha256 del DER de $CLIENT_CERT"
docker build -f deploy/Dockerfile --target runtime --label "org.opencontainers.image.revision=$REV" -t "$RUNTIME_TAG" .
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

confirmar "¿Migrar (026..037, una transaccion) y desplegar $REV?" || die "abortado por el dueño"

# B1 re-checked at the last instant: any terminal ticket issued meanwhile would abort schema 034.
PG_CONTAINER="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$ENV_FILE" | tail -1)-postgres-1"
PG_USER="$(sed -n 's/^POSTGRES_USER=//p' "$ENV_FILE" | tail -1)"; PG_DB="$(sed -n 's/^POSTGRES_DB=//p' "$ENV_FILE" | tail -1)"
fantasmas="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM terminal_sessions WHERE closed_at IS NULL AND revoked_at IS NULL")"
[ "$fantasmas" = "0" ] || die "hay $fantasmas sesiones de terminal sin anclar: la 034 abortaria (dossier B1: repite el UPDATE y reintenta)"
"${COMPOSE[@]}" run --rm -T migrator || die "migracion fallida (rollback automatico); NO se desplego nada"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 --remove-orphans || die "up fallo; para volver: restaurar $ENV_FILE.pre-deploy-$STAMP y repetir up"
"$REPO/deploy/smoke.sh" || die "SMOKE ROJO: evalua rollback (restaurar $ENV_FILE.pre-deploy-$STAMP + up -d --wait). La BD ya esta en 037."

echo "| $STAMP | $REV | $RUNTIME_DIGEST | $CONSOLE_DIGEST | smoke OK |" >> "$REPO/deploy/HISTORIAL.md"
echo "== deploy $REV COMPLETO. Registra el resultado en git (commit de HISTORIAL.md). =="
