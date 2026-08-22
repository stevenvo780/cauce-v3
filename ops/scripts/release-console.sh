#!/usr/bin/env bash
#
# release-console.sh — desplegar SÓLO la consola, de forma reproducible y con vuelta atrás.
#
# ============================================================================================
# POR QUÉ EXISTE ESTE FICHERO
# ============================================================================================
#
# El camino "sólo consola" ya existía a nivel de Docker: `deploy/Dockerfile` tiene un `--target
# console` y `deploy/compose.yaml` levanta el servicio `console` desde `CAUCE_CONSOLE_IMAGE`, que
# es un digest independiente del runtime. De hecho la vista «La flota ahora» se desplegó así el
# 2026-08-22 (imagen sha256:9ce73a84…). Lo que NO existía era el procedimiento ESCRITO.
#
# Y esa ausencia no es un detalle de documentación. Lo único escrito era:
#
#   - `ops/scripts/release-build.sh:16-17`, que construye SIEMPRE las dos imágenes (runtime y
#     consola) y escribe `build.json` con los dos digests;
#   - `ops/scripts/release-gate.sh:51-59`, que exige que los DOS digests locales coincidan con esa
#     evidencia — o sea que un cambio de consola obliga a reconstruir y revalidar el runtime.
#
# Con sólo eso escrito, el que despliega una corrección de consola tiene dos opciones y las dos son
# malas: mover el runtime sin necesidad (arriesgando el bus entero por un CSS), o improvisar los
# `docker build` a mano y dejar producción en un estado que ningún fichero del repo describe. Lo
# segundo es lo que pasó, y por eso este script existe: no aporta una capacidad nueva, aporta que
# la capacidad que ya se usaba sea REPETIBLE, verificable y reversible.
#
# ============================================================================================
# QUÉ HACE, Y POR QUÉ EN ESE ORDEN
# ============================================================================================
#
#   1. construye SÓLO `--target console`. El runtime no se toca ni se reconstruye;
#   2. transfiere la imagen al host de producción por SSH (stdin, sin registro intermedio);
#   3. RESPALDA `/etc/cauce-v3/prod.env` ANTES de tocarlo, y deja escrito el digest anterior;
#   4. cambia `CAUCE_CONSOLE_IMAGE` con una escritura atómica y validada, nunca con un `sed -i`;
#   5. recrea SÓLO el servicio `console` (`--no-deps`), así que gateway, dispatcher y outbox no se
#      reinician y ninguna entrega en vuelo se pierde por un cambio de pantalla;
#   6. VERIFICA POR EFECTO: que el bundle servido contenga la vista, y que la consola conteste 200.
#
# El paso 6 es la razón de ser del script. Un `docker compose up -d console` que sale con código 0
# no acredita nada: acredita que Docker aceptó la orden. Lo que hay que comprobar es que el HTML que
# el navegador recibe viene del bundle nuevo y que el servidor contesta. La lección está pagada en
# esta misma casa: `systemctl is-active`, el exit code 0 y el latido del lease mintieron los tres.
#
# ============================================================================================
# USO
# ============================================================================================
#
#   CAUCE_CONSOLE_TAG=cauce-console:20260822a \
#   CAUCE_PROD_HOST=kratos \
#     ops/scripts/release-console.sh desplegar
#
#   # y si algo salió mal (o si el paso 6 falló, que ya revierte solo):
#   CAUCE_PROD_HOST=kratos ops/scripts/release-console.sh revertir
#
# Variables:
#   CAUCE_CONSOLE_TAG    etiqueta local del build. Obligatoria en `desplegar`.
#   CAUCE_PROD_HOST      host SSH de producción. Obligatoria.
#   CAUCE_PROD_ENV_FILE  ruta del env en el host (default /etc/cauce-v3/prod.env).
#   CAUCE_COMPOSE_DIR    dónde vive deploy/compose.yaml en el host (default /datos/workspaces/cauce-v3).
#   CAUCE_COMPOSE_FILES  juego COMPLETO de ficheros de compose con el que producción está
#                        levantada, separados por espacios. Si no se declara, se pregunta al
#                        propio contenedor (label com.docker.compose.project.config_files).
#                        Producción se mudó de kratos a agora y allí son dos ficheros y el
#                        proyecto se llama `cauce-v3-prod`: con un solo fichero y sin cargar el
#                        env, `ps -q console` devuelve vacío y la verificación miente.
#   CAUCE_CONSOLE_PROBE  URL con la que se comprueba el 200 (default https://console:8444/ desde
#                        dentro del propio contenedor, con la CA montada — la misma sonda que ya usa
#                        el healthcheck de compose, para no inventar una comprobación paralela).
#   CAUCE_CONSOLE_MARCA  cadena que TIENE que aparecer en el bundle servido. Default: el nombre de la
#                        vista live. Sin esto, el paso 6 sólo probaría que nginx está vivo, no que
#                        está sirviendo el código que se acaba de construir.
#   CAUCE_RELEASE_PULL   1 (default) para `--pull`; 0 para reutilizar la base local.
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
accion=${1:-ayuda}

: "${CAUCE_PROD_HOST:?definí CAUCE_PROD_HOST: el host SSH de producción}"
env_remoto=${CAUCE_PROD_ENV_FILE:-/etc/cauce-v3/prod.env}
compose_dir=${CAUCE_COMPOSE_DIR:-/datos/workspaces/cauce-v3}
# Los ficheros de compose con los que producción está LEVANTADA, relativos a compose_dir.
# Tiene que ser el juego completo: preguntar por un subconjunto le cambia el modelo a compose y
# `ps -q console` puede devolver vacío aunque el contenedor esté corriendo. Se lee del propio host
# si no se declara: `docker inspect` sabe con qué ficheros se creó el contenedor, y esa es la
# fuente menos opinable que hay.
compose_files=${CAUCE_COMPOSE_FILES:-}
if [[ -z $compose_files ]]; then
  # Sin `$(...)` anidado dentro de la orden remota: el `\$` sobrevive a las comillas de acá pero
  # la sustitución acababa evaluándose antes de tiempo y al host remoto le llegaba `ps -q`, el ps
  # del sistema, que contestaba «List of process IDs must follow -q» y dejaba la detección en nada
  # sin que nadie lo notara, porque el `|| true` la tapaba y el respaldo funcionaba igual.
  # Un detector que siempre falla en silencio y cae al respaldo es peor que no tener detector.
  compose_files=$(ssh -o BatchMode=yes -o ControlMaster=no -o ControlPath=none "$CAUCE_PROD_HOST" \
    "docker ps -q --filter label=com.docker.compose.service=console | head -n1 | xargs -r docker inspect --format '{{ index .Config.Labels \"com.docker.compose.project.config_files\" }}' | tr ',' ' '" \
    2>/dev/null || true)
  compose_files=${compose_files:-${compose_dir}/deploy/compose.yaml}
fi
compose_args=''
for archivo in $compose_files; do compose_args+=" -f '${archivo}'"; done
marca=${CAUCE_CONSOLE_MARCA:-La flota ahora}
# Un ControlPath por host: compartir uno entre hosts distintos ya enrutó órdenes al servidor
# equivocado en esta flota, y una orden de despliegue no puede depender de esa lotería.
ssh_opts=(-o BatchMode=yes -o ControlMaster=no -o ControlPath=none)

remoto() { ssh "${ssh_opts[@]}" "$CAUCE_PROD_HOST" "$@"; }

# Todas las escrituras del env remoto pasan por acá: se escribe un temporal, se valida que el
# resultado siga teniendo la línea esperada y recién entonces se renombra. Un `sed -i` a medias
# sobre el env de producción deja el compose sin arrancar y sin nada que revertir.
escribir_env_remoto() {
  local nuevo_digest=$1
  remoto "
    set -euo pipefail
    umask 077
    tmp=\$(mktemp '${env_remoto}.nuevo.XXXXXX')
    # Se reescribe la línea entera, no se parchea in situ: si la variable no existía, se añade.
    if grep -q '^CAUCE_CONSOLE_IMAGE=' '${env_remoto}'; then
      sed 's|^CAUCE_CONSOLE_IMAGE=.*|CAUCE_CONSOLE_IMAGE=${nuevo_digest}|' '${env_remoto}' > \"\$tmp\"
    else
      cat '${env_remoto}' > \"\$tmp\"
      printf 'CAUCE_CONSOLE_IMAGE=%s\n' '${nuevo_digest}' >> \"\$tmp\"
    fi
    # Validación ANTES de mover: exactamente una línea, y con digest.
    [ \"\$(grep -c '^CAUCE_CONSOLE_IMAGE=' \"\$tmp\")\" = 1 ] || { echo 'el env quedaría con 0 o 2 CAUCE_CONSOLE_IMAGE' >&2; rm -f \"\$tmp\"; exit 1; }
    grep -q '^CAUCE_CONSOLE_IMAGE=.*@sha256:[0-9a-f]\{64\}\$' \"\$tmp\" || { echo 'el env quedaría sin digest inmutable' >&2; rm -f \"\$tmp\"; exit 1; }
    chown --reference='${env_remoto}' \"\$tmp\" 2>/dev/null || true
    chmod --reference='${env_remoto}' \"\$tmp\" 2>/dev/null || chmod 0600 \"\$tmp\"
    mv \"\$tmp\" '${env_remoto}'
  "
}

recrear_console() {
  # `--no-deps`: se recrea SÓLO la consola. Sin esto, compose arrastraría a `gateway` por el
  # `depends_on`, y reiniciar el gateway por un cambio de pantalla tira las conexiones WS de los
  # agentes y con ellas las entregas en vuelo.
  remoto "
    set -euo pipefail
    cd '${compose_dir}'
    set -a; . '${env_remoto}'; set +a
    docker compose${compose_args} up -d --no-deps --no-build console
  "
}

# --------------------------------------------------------------------------------------------
# La verificación POR EFECTO. Tres comprobaciones distintas porque cada una puede pasar mientras
# las otras dos fallan, y sólo las tres juntas dicen "la consola nueva está sirviendo".
# --------------------------------------------------------------------------------------------
verificar() {
  local esperado=$1

  # (a) El contenedor que está corriendo ES la imagen que se pineó. Compara el digest, no el
  #     nombre: el nombre de una imagen se puede reapuntar y el `up -d` puede haber sido un no-op.
  remoto "
    set -euo pipefail
    cd '${compose_dir}'
    # El env se carga TAMBIÉN acá. Sin él no hay COMPOSE_PROJECT_NAME ni CAUCE_RUNTIME_IMAGE, y
    # compose falla al interpolar o deduce un proyecto que no existe: en los dos casos `ps -q`
    # devuelve vacío y esta comprobación acusa un despliegue roto que no lo está. Es un falso
    # positivo de la verificación, que es la peor clase de fallo que puede tener una verificación.
    set -a; . '${env_remoto}'; set +a
    id_corriendo=\$(docker inspect --format '{{.Image}}' \$(docker compose${compose_args} ps -q console))
    id_pineado=\$(docker image inspect --format '{{.Id}}' '${esperado}')
    [ \"\$id_corriendo\" = \"\$id_pineado\" ] || { echo \"el contenedor corre \$id_corriendo y el env pinea \$id_pineado\" >&2; exit 1; }
  " || { printf 'VERIFICACIÓN (a) FALLÓ: el contenedor no corre la imagen pineada\n' >&2; return 1; }

  # (b) El BUNDLE que se sirve contiene la vista. Es la comprobación que separa "nginx está vivo"
  #     de "nginx está sirviendo el código nuevo": el HTML raíz sólo trae el <script src>, así que
  #     hay que bajar el propio bundle y buscar dentro. Un despliegue que deja el bundle viejo
  #     contesta 200 igual, y ése es exactamente el fallo que este paso existe para atrapar.
  remoto "
    set -euo pipefail
    cd '${compose_dir}'
    set -a; . '${env_remoto}'; set +a
    docker compose${compose_args} exec -T console sh -c '
      set -eu
      export SSL_CERT_FILE=/run/secrets/console_tls_ca
      html=\$(wget -q -O - https://console:8444/)
      bundle=\$(printf \"%s\" \"\$html\" | grep -o \"/assets/[A-Za-z0-9_.-]*\.js\" | head -n1)
      [ -n \"\$bundle\" ] || { echo \"no encontré el <script src> del bundle en el HTML servido\" >&2; exit 1; }
      wget -q -O - \"https://console:8444\$bundle\" | grep -q \"${marca}\" || {
        echo \"el bundle servido (\$bundle) NO contiene: ${marca}\" >&2; exit 1; }
      printf \"bundle servido con la vista dentro: %s\n\" \"\$bundle\"
    '
  " || { printf 'VERIFICACIÓN (b) FALLÓ: el bundle servido no contiene «%s»\n' "$marca" >&2; return 1; }

  # (c) Y contesta 200 de verdad, con TLS y verificando el certificado. Va última a propósito: es
  #     la más débil de las tres (un bundle viejo también da 200) y sirve de cierre, no de prueba.
  remoto "
    set -euo pipefail
    cd '${compose_dir}'
    set -a; . '${env_remoto}'; set +a
    docker compose${compose_args} exec -T console sh -c '
      SSL_CERT_FILE=/run/secrets/console_tls_ca wget -q -S -O /dev/null https://console:8444/ 2>&1 | grep -q \"HTTP/1.1 200\"'
  " || { printf 'VERIFICACIÓN (c) FALLÓ: la consola no contesta 200\n' >&2; return 1; }

  printf 'verificado por efecto: imagen pineada corriendo, bundle con la vista dentro y 200 con TLS\n'
}

case "$accion" in
  desplegar)
    : "${CAUCE_CONSOLE_TAG:?definí CAUCE_CONSOLE_TAG: la etiqueta local del build de consola}"
    command -v docker >/dev/null 2>&1 || { printf 'falta docker\n' >&2; exit 127; }

    pull_args=()
    case ${CAUCE_RELEASE_PULL:-1} in
      1) pull_args=(--pull) ;;
      0) ;;
      *) printf 'CAUCE_RELEASE_PULL tiene que ser 0 o 1\n' >&2; exit 2 ;;
    esac

    # 1 — SÓLO la consola. Ni una capa del runtime se reconstruye ni se vuelve a publicar.
    docker build "${pull_args[@]}" --target console -t "$CAUCE_CONSOLE_TAG" -f "$ROOT/deploy/Dockerfile" "$ROOT"
    console_id=$(docker image inspect --format '{{.Id}}' "$CAUCE_CONSOLE_TAG")
    [[ $console_id =~ ^sha256:[a-f0-9]{64}$ ]] || { printf 'el build no devolvió un digest válido\n' >&2; exit 1; }
    # El digest que se pinea en el env: nombre + @sha256, para que compose no pueda resolver la
    # etiqueta a otra imagen si alguien la reapunta entre el build y el arranque.
    nombre=${CAUCE_CONSOLE_TAG%%:*}
    digest_pineado="${nombre}@${console_id}"

    # 2 — transferencia por stdin. Sin registro intermedio no hay una tercera copia que pueda
    #     divergir, y el `docker load` remoto falla ruidosamente si el stream llega cortado.
    printf 'transfiriendo %s a %s…\n' "$CAUCE_CONSOLE_TAG" "$CAUCE_PROD_HOST"
    docker save "$CAUCE_CONSOLE_TAG" | remoto 'docker load'
    remoto "docker image inspect --format '{{.Id}}' '${CAUCE_CONSOLE_TAG}'" | grep -qx "$console_id" || {
      printf 'la imagen que quedó en el host NO tiene el digest que se construyó acá\n' >&2; exit 1; }
    # `docker load` restaura la etiqueta pero no el nombre@digest: se re-etiqueta explícitamente
    # para que el env pueda referirse a él y compose lo resuelva sin salir a ningún registro.
    remoto "docker tag '${console_id}' '${digest_pineado}' 2>/dev/null || true"

    # 3 — RESPALDO antes de tocar nada, y con el digest anterior guardado aparte, en texto, para
    #     que la vuelta atrás no dependa de saber leer un backup.
    sello=$(date -u +%Y%m%dT%H%M%SZ)
    remoto "
      set -euo pipefail
      cp -a '${env_remoto}' '${env_remoto}.respaldo.${sello}'
      grep '^CAUCE_CONSOLE_IMAGE=' '${env_remoto}' | sed 's/^CAUCE_CONSOLE_IMAGE=//' > '${env_remoto}.console-anterior' || true
      ln -sfn '${env_remoto}.respaldo.${sello}' '${env_remoto}.respaldo.ultimo'
    "
    anterior=$(remoto "cat '${env_remoto}.console-anterior' 2>/dev/null || true")
    printf 'respaldo: %s.respaldo.%s (consola anterior: %s)\n' "$env_remoto" "$sello" "${anterior:-ninguna}"

    # 4 y 5 — pinear y recrear sólo la consola.
    escribir_env_remoto "$digest_pineado"
    recrear_console

    # 6 — verificar por efecto. Si falla, se revierte SOLO, acá mismo: dejar producción a medias
    #     con un mensaje de error es peor que no haber desplegado, porque nadie sabe en qué estado
    #     quedó y el siguiente que mire va a leer el env nuevo creyendo que es lo que corre.
    if ! verificar "$digest_pineado"; then
      printf 'la verificación falló: revirtiendo automáticamente\n' >&2
      if [[ -n $anterior ]]; then
        escribir_env_remoto "$anterior"
        recrear_console
        verificar "$anterior" || printf 'ATENCIÓN: la reversión tampoco verificó. Escalar a zeus con esta salida cruda.\n' >&2
      else
        printf 'ATENCIÓN: no había digest anterior guardado; el env quedó apuntando al nuevo. Revisar a mano.\n' >&2
      fi
      exit 1
    fi

    printf 'consola desplegada: %s\n' "$digest_pineado"
    printf 'para volver atrás: CAUCE_PROD_HOST=%s %s revertir\n' "$CAUCE_PROD_HOST" "$0"
    ;;

  revertir)
    # La vuelta atrás vive en el MISMO fichero que el despliegue a propósito. Un rollback que hay
    # que buscar en otro sitio, en medio de un incidente, es un rollback que no se ejecuta.
    anterior=$(remoto "cat '${env_remoto}.console-anterior' 2>/dev/null || true")
    [[ -n $anterior ]] || { printf 'no hay digest anterior guardado en %s.console-anterior\n' "$env_remoto" >&2; exit 2; }
    [[ $anterior == *@sha256:* ]] || { printf 'el digest anterior no está pineado por sha256: %s\n' "$anterior" >&2; exit 2; }
    remoto "docker image inspect '${anterior}' >/dev/null" || {
      printf 'la imagen anterior ya no está en el host: %s. No se revierte a ciegas.\n' "$anterior" >&2; exit 1; }

    escribir_env_remoto "$anterior"
    recrear_console
    verificar "$anterior"
    printf 'revertido a %s\n' "$anterior"
    ;;

  verificar)
    # Sirve suelta: comprobar sin desplegar es lo primero que hace falta cuando alguien dice "la
    # consola está rara" y nadie sabe qué versión está sirviendo.
    actual=$(remoto "grep '^CAUCE_CONSOLE_IMAGE=' '${env_remoto}' | sed 's/^CAUCE_CONSOLE_IMAGE=//'")
    printf 'env pinea: %s\n' "$actual"
    verificar "$actual"
    ;;

  *)
    printf 'uso: %s desplegar|revertir|verificar\n' "$0" >&2
    printf '  desplegar  construye --target console, pinea, recrea sólo console y verifica por efecto\n' >&2
    printf '  revertir   vuelve al digest guardado en %s.console-anterior\n' "$env_remoto" >&2
    printf '  verificar  no cambia nada: comprueba qué está sirviendo la consola ahora mismo\n' >&2
    exit 2
    ;;
esac
