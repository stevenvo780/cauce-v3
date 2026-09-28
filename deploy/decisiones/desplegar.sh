#!/usr/bin/env bash
# Deploys the decisions service on vpstn as its own compose project (cauce-decisiones).
# Modes: plan <commit> (changes nothing) | aplicar <commit> | anterior | recrear | revertir | estado.
# Never prints, copies or reads the content of the Jev key: only its owner and mode are touched.
set -euo pipefail
shopt -s inherit_errexit

MODO=${1:-plan}
COMMIT=${2:-HEAD}
PROD_ENV=${CAUCE_ENV_FILE:-/etc/cauce-v3/prod.env}
ENV_FILE=${CAUCE_DECISIONES_ENV_FILE:-/etc/cauce-v3/decisiones.env}
REVERT_FILE=${CAUCE_DECISIONES_REVERT_FILE:-/etc/cauce-v3/decisiones.revert}
DESPLIEGUES=${CAUCE_DECISIONES_DEPLOY_DIR:-/etc/cauce-v3/decisiones.d}
KEY=${CAUCE_TYPESAFE_JEV_KEY_PATH:-/etc/cauce-v3/secrets/typesafe-jev.key}
SMOKE_PKI=${CAUCE_DECISIONES_SMOKE_PKI:-/home/stev/.config/cauce-v3/container-pki/zeus}
PROJECT=cauce-decisiones
SERVICE_USER=stev
PORT=8447

die() { printf 'desplegar-decisiones: %s\n' "$*" >&2; exit 1; }
paso() { printf '\n== %s\n' "$*"; }
valor_de() { [[ -f $2 ]] || return 0; sed -n "s/^$1=//p" "$2" | tail -1; }
fijar() { if grep -q "^$1=" "$3"; then sed -i "s|^$1=.*|$1=$2|" "$3"; else printf '%s=%s\n' "$1" "$2" >> "$3"; fi; }

# Any clone holding the commit works, whatever branch it has checked out: the script, the compose
# file and the image all come from the commit, not from the working tree.
repositorio() {
  if [[ -n ${CAUCE_DECISIONES_GIT:-} ]]; then printf '%s' "$CAUCE_DECISIONES_GIT"; return; fi
  git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null \
    || die 'no encuentro el repositorio: fijá CAUCE_DECISIONES_GIT a un clon que tenga el commit'
}

compose_de() { printf '%s/%s/compose.yaml' "$DESPLIEGUES" "${1##*:}"; }
compose() {
  local fichero
  [[ -f $ENV_FILE ]] || die "no existe $ENV_FILE: todavía no se aplicó"
  fichero=$(compose_de "$(valor_de CAUCE_DECISIONES_IMAGE "$ENV_FILE")")
  [[ -f $fichero ]] || die "falta $fichero, el compose con el que se desplegó esa imagen"
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$fichero" --project-directory "$(dirname "$fichero")" "$@"
}

requisitos() {
  [[ $(id -u) == 0 ]] || die "necesita root: cambia el dueño de la clave y lee $PROD_ENV"
  command -v docker >/dev/null || die 'falta docker'
  [[ -r $PROD_ENV ]] || die "no puedo leer $PROD_ENV"
  [[ $(id -u "$SERVICE_USER") == 1000 ]] || die "$SERVICE_USER no es uid 1000: el contenedor corre como 1000:1000"
  [[ -f $KEY ]] || die "no existe $KEY"
}

resolver() {
  local repo sha
  repo=$(repositorio)
  sha=$(git -C "$repo" rev-parse --verify --quiet "$COMMIT^{commit}") \
    || die "commit desconocido en $repo: $COMMIT (fijá CAUCE_DECISIONES_GIT a un clon que lo tenga)"
  git -C "$repo" cat-file -e "$sha:deploy/decisiones/compose.yaml" 2>/dev/null || die "el commit $sha no trae deploy/decisiones"
  printf '%s' "$sha"
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
  sha=$(resolver)
  paso "commit a desplegar: $sha (de $(repositorio))"
  paso "dueño y modo de la clave (se necesita $SERVICE_USER:$SERVICE_USER 400): $(stat -c '%U:%G %a' "$KEY")"
  paso "fichero de entorno propuesto ($ENV_FILE)"
  if [[ -f $ENV_FILE ]]; then cat "$ENV_FILE"; else generar_env "$PROJECT:${sha:0:12}"; fi
  paso "puerto $PORT"
  puerto_libre && echo libre-o-nuestro
  paso "pasos de aplicar: clave → imagen desde git archive → compose del commit en $DESPLIEGUES/${sha:0:12} → up --wait → humo"
  echo "reversa: $0 anterior (imagen previa) o $0 revertir (bajar el servicio)"
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
  local sha=$1 imagen=$2 repo temporal
  repo=$(repositorio)
  temporal=$(mktemp -d)
  git -C "$repo" archive "$sha" | tar -x -C "$temporal"
  docker build -f "$temporal/deploy/decisiones/Dockerfile" --build-arg "CAUCE_RELEASE_COMMIT=$sha" -t "$imagen" "$temporal"
  rm -rf "$temporal"
  install -d -m 0700 "$DESPLIEGUES/${sha:0:12}"
  git -C "$repo" show "$sha:deploy/decisiones/compose.yaml" > "$DESPLIEGUES/${sha:0:12}/compose.yaml"
}

humo() {
  local bind presentado
  local cliente=()
  bind=$(valor_de CAUCE_PRIVATE_BIND_IP "$ENV_FILE")
  paso 'health interno'
  compose exec -T decisiones node -e "fetch('http://127.0.0.1:8088/health/ready').then((r)=>r.json()).then((j)=>{console.log(JSON.stringify(j));process.exit(j.credencial_jev===true?0:1)})" \
    || die 'health rojo o sin credencial de Jev'
  paso "TLS en $bind:$PORT"
  if [[ -r $SMOKE_PKI/client.key ]]; then cliente=(-cert "$SMOKE_PKI/client.crt" -key "$SMOKE_PKI/client.key"); fi
  # s_client exits 1 at random when the server demands a client certificate: its status says nothing.
  presentado=$(openssl s_client -connect "$bind:$PORT" ${cliente[@]+"${cliente[@]}"} </dev/null 2>/dev/null || true)
  printf '%s\n' "$presentado" | openssl x509 -noout -subject || die 'no presenta certificado'
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
  local sha imagen previa
  sha=$(resolver)
  imagen="$PROJECT:${sha:0:12}"
  paso "clave de Jev → $SERVICE_USER:$SERVICE_USER 0400 (lo previo queda en $REVERT_FILE)"
  ajustar_clave
  paso "imagen $imagen desde git archive $sha"
  construir "$sha" "$imagen"
  if [[ -f $ENV_FILE ]]; then
    previa=$(valor_de CAUCE_DECISIONES_IMAGE "$ENV_FILE")
    [[ -z $previa || $previa == "$imagen" ]] || fijar IMAGEN_ANTES "$previa" "$REVERT_FILE"
    fijar CAUCE_DECISIONES_IMAGE "$imagen" "$ENV_FILE"
  else
    (umask 077 && generar_env "$imagen" > "$ENV_FILE")
  fi
  puerto_libre
  compose config -q || die "el compose no renderiza con $ENV_FILE"
  paso 'up'
  compose up -d --wait --wait-timeout 120 || die "up falló; reversa: $0 anterior, o $0 revertir"
  humo
  paso "hecho: $imagen. Registrá en deploy/HISTORIAL.md y habilitá alias de a uno (DECISIONES_URL + registrar-mcp)."
}

# Back to the image the last aplicar replaced, with the compose file it shipped with; no rebuild.
modo_anterior() {
  requisitos
  local antes actual
  [[ -f $ENV_FILE ]] || die "no existe $ENV_FILE: todavía no se aplicó"
  antes=$(valor_de IMAGEN_ANTES "$REVERT_FILE")
  actual=$(valor_de CAUCE_DECISIONES_IMAGE "$ENV_FILE")
  [[ -n $antes ]] || die "no hay imagen anterior anotada en $REVERT_FILE: bajá el servicio con $0 revertir"
  docker image inspect "$antes" >/dev/null 2>&1 || die "la imagen $antes ya no está: reconstruila con $0 aplicar <su commit>"
  [[ -f $(compose_de "$antes") ]] || die "falta $(compose_de "$antes"): reconstruila con $0 aplicar <su commit>"
  paso "de $actual a $antes"
  fijar CAUCE_DECISIONES_IMAGE "$antes" "$ENV_FILE"
  fijar IMAGEN_ANTES "$actual" "$REVERT_FILE"
  compose up -d --wait --wait-timeout 120 || die "up falló con $antes"
  humo
}

# After the key file was replaced (mv/install) rather than rewritten in place: owner, mode and a new
# container, since a file secret is a bind mount pinned to the old inode.
modo_recrear() {
  requisitos
  ajustar_clave
  compose up -d --wait --wait-timeout 120 --force-recreate || die 'up falló'
  humo
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
  echo 'quitá también DECISIONES_URL de los <alias>.env (la línea entera, antes de volver el supervisor) y la entrada cauce-decisiones de cada arnés (registrar-mcp.py --quitar)'
}

modo_estado() {
  requisitos
  compose ps
  compose exec -T decisiones node -e "fetch('http://127.0.0.1:8088/health/ready').then((r)=>r.json()).then((j)=>{console.log(JSON.stringify(j));if(j.credencial_jev!==true)console.error('AVISO: no lee la clave de Jev; todas las decisiones responden jev_sin_credencial')})" || true
  echo "imagen: $(valor_de CAUCE_DECISIONES_IMAGE "$ENV_FILE") · anterior: $(valor_de IMAGEN_ANTES "$REVERT_FILE")"
}

case "$MODO" in
  plan) modo_plan ;;
  aplicar) modo_aplicar ;;
  anterior) modo_anterior ;;
  recrear) modo_recrear ;;
  revertir) modo_revertir ;;
  estado) modo_estado ;;
  *) die "uso: $0 plan|aplicar <commit>|anterior|recrear|revertir|estado" ;;
esac
