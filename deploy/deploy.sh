#!/usr/bin/env bash
# Despliegue simple de Cauce V3 (FASE 3). Sustituye a la maquinaria retirada del árbol (histórico en git).
# Contrato: build -> pin por digest -> migrar -> up -> smoke -> registrar. Todo o rollback.
# SOLO se ejecuta con el dueño presente: exige CAUCE_FASE3_CON_DUENO=si.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${CAUCE_ENV_FILE:-/etc/cauce-v3/prod.env}"
REGISTRY="127.0.0.1:5000"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$REPO/deploy/compose.yaml" -f "$REPO/deploy/compose.postgres.yaml" --project-directory "$REPO/deploy")

die() { echo "deploy: $*" >&2; exit 1; }

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
  read -r -p "¿Continuar igual? (si/NO) " ok; [ "$ok" = "si" ] || die "abortado por falta de backup fresco"
fi

# Build con procedencia (la consola compila desde la raiz: su Dockerfile hace COPY . . + pnpm)
docker build -f deploy/Dockerfile --label "org.opencontainers.image.revision=$REV" -t "$RUNTIME_TAG" .
docker build -f console/Dockerfile --label "org.opencontainers.image.revision=$REV" -t "$CONSOLE_TAG" .
docker push -q "$RUNTIME_TAG" && docker push -q "$CONSOLE_TAG"
RUNTIME_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$RUNTIME_TAG")"
CONSOLE_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$CONSOLE_TAG")"
echo "runtime: $RUNTIME_DIGEST"
echo "console: $CONSOLE_DIGEST"

cp -a "$ENV_FILE" "$ENV_FILE.pre-deploy-$STAMP"
sed -i "s|^CAUCE_RUNTIME_IMAGE=.*|CAUCE_RUNTIME_IMAGE=$RUNTIME_DIGEST|" "$ENV_FILE"
sed -i "s|^CAUCE_CONSOLE_IMAGE=.*|CAUCE_CONSOLE_IMAGE=$CONSOLE_DIGEST|" "$ENV_FILE"
grep -q "^CAUCE_TERMINAL_RELAY_INSTANCE_ID=" "$ENV_FILE" || die "falta CAUCE_TERMINAL_RELAY_INSTANCE_ID en $ENV_FILE (dossier B2)"

"${COMPOSE[@]}" config >/dev/null || die "el compose canonico no renderiza con $ENV_FILE"

read -r -p "¿Migrar (026..037, una transaccion) y desplegar $REV? (si/NO) " ok; [ "$ok" = "si" ] || die "abortado por el dueño"

"${COMPOSE[@]}" run --rm migrator || die "migracion fallida (rollback automatico); NO se desplego nada"
"${COMPOSE[@]}" up -d --wait --remove-orphans || die "up fallo; para volver: restaurar $ENV_FILE.pre-deploy-$STAMP y repetir up"
"$REPO/deploy/smoke.sh" || die "SMOKE ROJO: evalua rollback (restaurar $ENV_FILE.pre-deploy-$STAMP + up -d --wait). La BD ya esta en 037."

echo "| $STAMP | $REV | $RUNTIME_DIGEST | $CONSOLE_DIGEST | smoke OK |" >> "$REPO/deploy/HISTORIAL.md"
echo "== deploy $REV COMPLETO. Registra el resultado en git (commit de HISTORIAL.md). =="
