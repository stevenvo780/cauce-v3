#!/usr/bin/env bash
# Deploys the decisions service on vpstn as its own compose project (cauce-decisiones).
# Modes: plan (default, changes nothing) | aplicar <commit> | revertir | estado.
# Never prints, copies or reads the content of the Jev key: only its owner and mode are touched.
set -euo pipefail

MODO=${1:-plan}
COMMIT=${2:-HEAD}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROD_ENV=${CAUCE_ENV_FILE:-/etc/cauce-v3/prod.env}
ENV_FILE=${CAUCE_DECISIONES_ENV_FILE:-/etc/cauce-v3/decisiones.env}
REVERT_FILE=${CAUCE_DECISIONES_REVERT_FILE:-/etc/cauce-v3/decisiones.revert}
KEY=${CAUCE_TYPESAFE_JEV_KEY_PATH:-/etc/cauce-v3/secrets/typesafe-jev.key}
SMOKE_PKI=${CAUCE_DECISIONES_SMOKE_PKI:-/home/stev/.config/cauce-v3/container-pki/zeus}
PROJECT=cauce-decisiones
SERVICE_USER=stev
PORT=8447

die() { printf 'desplegar-decisiones: %s\n' "$*" >&2; exit 1; }
paso() { printf '\n== %s\n' "$*"; }
valor_de() { sed -n "s/^$1=//p" "$2" | tail -1; }
compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$REPO/deploy/decisiones/compose.yaml" \
    --project-directory "$REPO/deploy/decisiones" "$@"
}

requisitos() {
  [[ $(id -u) == 0 ]] || die "necesita root: cambia el dueño de la clave y lee $PROD_ENV"
  command -v docker >/dev/null || die 'falta docker'
  [[ -r $PROD_ENV ]] || die "no puedo leer $PROD_ENV"
  [[ $(id -u "$SERVICE_USER") == 1000 ]] || die "$SERVICE_USER no es uid 1000: el contenedor corre como 1000:1000"
  [[ -f $KEY ]] || die "no existe $KEY"
}

# Paths only, taken from prod.env so the service reuses the gateway's PKI and identity registry.
generar_env() {
  local imagen=$1 bind cert clave ca identidades
  bind=$(valor_de CAUCE_PRIVATE_BIND_IP "$PROD_ENV")
  cert=$(valor_de CAUCE_GATEWAY_TLS_CERT_PATH "$PROD_ENV")
  clave=$(valor_de CAUCE_GATEWAY_TLS_KEY_PATH "$PROD_ENV")
  ca=$(valor_de CAUCE_GATEWAY_CLIENT_CA_PATH "$PROD_ENV")
  identidades=$(valor_de CAUCE_GATEWAY_IDENTITY_DIR "$PROD_ENV")
  for par in "CAUCE_PRIVATE_BIND_IP=$bind" "CAUCE_GATEWAY_TLS_CERT_PATH=$cert" "CAUCE_GATEWAY_TLS_KEY_PATH=$clave" \
    "CAUCE_GATEWAY_CLIENT_CA_PATH=$ca" "CAUCE_GATEWAY_IDENTITY_DIR=$identidades"; do
    [[ -n ${par#*=} ]] || die "falta ${par%%=*} en $PROD_ENV"
  done
  [[ -f $identidades/mtls_identities.json ]] || die "no existe $identidades/mtls_identities.json"
  printf '%s\n' \
    "CAUCE_DECISIONES_IMAGE=$imagen" "CAUCE_PRIVATE_BIND_IP=$bind" "CAUCE_DECISIONES_TLS_PORT=$PORT" \
    "CAUCE_GATEWAY_TLS_CERT_PATH=$cert" "CAUCE_GATEWAY_TLS_KEY_PATH=$clave" "CAUCE_GATEWAY_CLIENT_CA_PATH=$ca" \
    "CAUCE_GATEWAY_IDENTITY_DIR=$identidades" "CAUCE_TYPESAFE_JEV_KEY_PATH=$KEY" \
    'CAUCE_DECISIONES_ALIASES=zeus' 'CAUCE_DECISIONES_TENANTS=Steven' 'CAUCE_DECISIONES_HABILITAR_PLANTILLAS=' \
    'CAUCE_DECISIONES_JEV_MODEL=jev-latest'
}

puerto_libre() {
  local bind
  bind=$(valor_de CAUCE_PRIVATE_BIND_IP "$PROD_ENV")
  if ss -ltnH "( sport = :$PORT )" | grep -q .; then
    compose ps --status running -q 2>/dev/null | grep -q . || die "el puerto $PORT ya está ocupado en $bind por otro proceso"
  fi
}

modo_plan() {
  requisitos
  local sha
  sha=$(git -C "$REPO" rev-parse --verify "$COMMIT^{commit}") || die "commit desconocido: $COMMIT"
  paso "commit a desplegar: $sha"
  paso "dueño y modo de la clave (se necesita $SERVICE_USER:$SERVICE_USER 400): $(stat -c '%U:%G %a' "$KEY")"
  paso "fichero de entorno propuesto ($ENV_FILE)"
  if [[ -f $ENV_FILE ]]; then cat "$ENV_FILE"; else generar_env "$PROJECT:${sha:0:12}"; fi
  paso "puerto $PORT"
  puerto_libre && echo libre-o-nuestro
  paso 'pasos de aplicar: clave → imagen desde git archive → up --wait → humo (health, TLS, una decisión real)'
  echo "reversa: $0 revertir"
}

ajustar_clave() {
  local antes
  antes=$(stat -c '%U:%G:%a' "$KEY")
  [[ -f $REVERT_FILE ]] || printf 'CLAVE_ANTES=%s\n' "$antes" > "$REVERT_FILE"
  chmod 0600 "$REVERT_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$KEY"
  chmod 0400 "$KEY"
}

construir() {
  local sha=$1 imagen=$2 temporal
  temporal=$(mktemp -d)
  git -C "$REPO" archive "$sha" | tar -x -C "$temporal"
  docker build -f "$temporal/deploy/decisiones/Dockerfile" --build-arg "CAUCE_RELEASE_COMMIT=$sha" -t "$imagen" "$temporal"
  rm -rf "$temporal"
}

humo() {
  local bind
  bind=$(valor_de CAUCE_PRIVATE_BIND_IP "$ENV_FILE")
  paso 'health interno'
  compose exec -T decisiones node -e "fetch('http://127.0.0.1:8088/health/ready').then((r)=>r.json()).then((j)=>{console.log(JSON.stringify(j));process.exit(j.credencial_jev===true?0:1)})" \
    || die 'health rojo o sin credencial de Jev'
  paso "TLS en $bind:$PORT"
  openssl s_client -connect "$bind:$PORT" </dev/null 2>/dev/null | openssl x509 -noout -subject || die 'no presenta certificado'
  if [[ -r $SMOKE_PKI/client.key ]]; then
    paso 'una decisión real con el certificado de zeus'
    curl -sS --fail-with-body --max-time 40 --cert "$SMOKE_PKI/client.crt" --key "$SMOKE_PKI/client.key" --cacert "$SMOKE_PKI/ca.crt" \
      -H 'content-type: application/json' -d '{"plantilla":"requiere_respuesta","state":{"mensaje":"Gracias, recibido."}}' \
      "https://$bind:$PORT/v1/decidir" || die 'la decisión de humo falló'
    echo
  else
    echo "sin $SMOKE_PKI/client.key: no probé una decisión real"
  fi
}

modo_aplicar() {
  requisitos
  local sha imagen
  sha=$(git -C "$REPO" rev-parse --verify "$COMMIT^{commit}") || die "commit desconocido: $COMMIT"
  imagen="$PROJECT:${sha:0:12}"
  paso "clave de Jev → $SERVICE_USER:$SERVICE_USER 0400 (lo previo queda en $REVERT_FILE)"
  ajustar_clave
  paso "imagen $imagen desde git archive $sha"
  construir "$sha" "$imagen"
  if [[ -f $ENV_FILE ]]; then
    grep -q '^IMAGEN_ANTES=' "$REVERT_FILE" || printf 'IMAGEN_ANTES=%s\n' "$(valor_de CAUCE_DECISIONES_IMAGE "$ENV_FILE")" >> "$REVERT_FILE"
    sed -i "s|^CAUCE_DECISIONES_IMAGE=.*|CAUCE_DECISIONES_IMAGE=$imagen|" "$ENV_FILE"
  else
    (umask 077 && generar_env "$imagen" > "$ENV_FILE")
  fi
  puerto_libre
  compose config -q || die "el compose no renderiza con $ENV_FILE"
  paso 'up'
  compose up -d --wait --wait-timeout 120 || die "up falló; reversa: $0 revertir"
  humo
  paso "hecho: $imagen. Registrá en deploy/HISTORIAL.md y habilitá alias de a uno (DECISIONES_URL + registrar-mcp)."
}

modo_revertir() {
  requisitos
  paso 'bajando el proyecto cauce-decisiones (el volumen de auditoría se conserva)'
  if [[ -f $ENV_FILE ]]; then compose down; fi
  if [[ -f $REVERT_FILE ]]; then
    local antes dueno modo
    antes=$(valor_de CLAVE_ANTES "$REVERT_FILE")
    if [[ $antes =~ ^([a-z_][a-z0-9_-]*:[a-z_][a-z0-9_-]*):([0-7]{3})$ ]]; then
      dueno=${BASH_REMATCH[1]}
      modo=${BASH_REMATCH[2]}
      chown "$dueno" "$KEY"
      chmod "$modo" "$KEY"
      paso "clave devuelta a $dueno $modo"
    fi
  fi
  echo 'quitá también DECISIONES_URL de los <alias>.env y la entrada cauce-decisiones de cada arnés (registrar-mcp.py --quitar)'
}

modo_estado() {
  requisitos
  compose ps
  compose exec -T decisiones node -e "fetch('http://127.0.0.1:8088/health/ready').then((r)=>r.text()).then(console.log)" || true
}

case "$MODO" in
  plan) modo_plan ;;
  aplicar) modo_aplicar ;;
  revertir) modo_revertir ;;
  estado) modo_estado ;;
  *) die "uso: $0 plan|aplicar <commit>|revertir|estado" ;;
esac
