#!/usr/bin/env bash
# cauce — envoltorio local: corre el `cauce` de verdad, que vive en kratos, sin tener que hacer
# el ssh a mano.
#
# Por que existe: el CLI real es kratos:~/.local/bin/cauce y necesita estar en la torre (habla con
# docker y con las sesiones tmux de los contenedores). Desde el portatil hacia falta acordarse del
# `ssh kratos` y ademas del `bash -lc`, porque kratos usa FISH y el quoting se rompe.
#
# Uso:  cauce                      lista la flota
#       cauce <alias>              entra a la sesion (interactivo, pide TTY)
#       cauce <alias> ver          mira sin tocar
#       cauce <alias> sesiones     que conversaciones tiene y cual comparte
#       cauce <alias> on|off       enciende / apaga su adaptador, comprobando de verdad
#       cauce probar <alias>       entrega REAL por el gateway + la marca en el panel
#       cauce soltar <alias>       suelta el pestillo de la ventana tmux
set -uo pipefail

HOST=${CAUCE_HOST:-kratos}
REMOTO=${CAUCE_REMOTO:-\$HOME/.local/bin/cauce}

# `probar` no puede vivir en la torre: publicar al bus necesita el certificado de consola, que esta
# en agora-storage, y kratos NO tiene llave hacia alla. El portatil si llega a las dos maquinas, asi
# que la prueba se orquesta desde aca.
#
# Que comprueba, y por que las tres cosas: publica una entrega REAL por el gateway (mTLS), espera a
# que la fila quede en estado terminal, y ADEMAS mira el panel tmux. Las tres hacen falta: una
# entrega `done` no prueba que el turno haya pasado por la TUI —el fan-in lo sintetiza el SDK en
# local, sin tocar el arnes— y un panel con texto no prueba que el bus lo haya visto.
if [ "${1:-}" = probar ]; then
  shift
  [ $# -ge 1 ] || { echo "uso: cauce probar <alias>" >&2; exit 2; }
  A=$1
  [[ $A =~ ^[A-Za-z0-9_-]+$ ]] || { echo "alias invalido: $A" >&2; exit 2; }
  TEN=$(ssh -o BatchMode=yes "$HOST" "bash -lc $(printf '%q' "python3 \$HOME/.local/share/cauce-v3/ops/scripts/container-alias-query.py $(printf '%q' "$A")")" 2>/dev/null | cut -f1)
  [ -n "$TEN" ] || { echo "alias desconocido: $A" >&2; exit 2; }
  MARCA="PROBAR-$(tr -dc a-f0-9 </dev/urandom | head -c 8)"
  echo "  publicando entrega real a $A (tenant $TEN) con marca $MARCA"
  # shellcheck disable=SC2087
  RESP=$(ssh -o BatchMode=yes agora-storage "cat > /tmp/cauce-probar.json && curl -sS -k \
      --cert /etc/cauce-v3/pki/console-client.crt --key /etc/cauce-v3/pki/console-client.key \
      -H 'content-type: application/json' -H 'x-cauce-operator: steven' \
      -X POST https://100.64.0.6:8443/v3/messages --data @/tmp/cauce-probar.json; \
      rm -f /tmp/cauce-probar.json" <<JSON
{"room_id":"grp.steven","recipients":[{"tenant_id":"$TEN","alias":"$A"}],"body":{"text":"Prueba de vida de Cauce. Responde UNICAMENTE con: $MARCA"},"idempotency_key":"probar-$A-$MARCA","lane":"interactive","priority":5}
JSON
)
  ID=$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["delivery_ids"][0])
except Exception: pass' 2>/dev/null)
  [ -n "$ID" ] || { echo "  el gateway rechazo la publicacion:"; echo "  $RESP"; exit 1; }

  # El deadline de ACK en produccion es de 30 MINUTOS: una entrega colgada no da error rapido, se
  # ve como un agente mudo. Por eso se espera con techo y se dice cuanto se espero.
  #
  # Y el panel hay que mirarlo MIENTRAS corre el turno, no al final: la TUI de claude vive en
  # pantalla alterna con history_size=0, asi que `capture-pane` solo ve la pantalla ACTUAL. Cuando
  # el turno termina, la pantalla se redibuja y la marca desaparece — mirando solo al final se
  # reporta "el turno no paso por el arnes" sobre un turno que paso perfectamente.
  echo -n "  esperando"
  EST=; REPLY_TXT=; VISTO=; PANEL=; RC_PANEL=0
  [[ $ID =~ ^[0-9a-f-]{36}$ ]] || { echo "id de entrega invalido: $ID" >&2; exit 3; }
  for _ in $(seq 1 60); do
    R=$(ssh -o BatchMode=yes agora-storage "docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce -At -F'|' -c \"select status, coalesce(regexp_replace(result#>>'{output,reply}','\\s+',' ','g'),'-') from deliveries where id='$ID';\"" 2>/dev/null)
    EST=${R%%|*}; REPLY_TXT=${R#*|}
    if [ -z "$VISTO" ] && [ "$RC_PANEL" != 3 ]; then
      PANEL=$(ssh -o BatchMode=yes "$HOST" "bash -lc $(printf '%q' "\$HOME/.local/bin/cauce-panel $(printf '%q' "$A")")" 2>/dev/null)
      RC_PANEL=$?
      printf '%s' "$PANEL" | grep -qF "$MARCA" && VISTO=1
    fi
    case "$EST" in done|failed|dead) break;; esac
    echo -n "."; sleep 4
  done
  # Una ultima mirada: si el turno fue mas rapido que el sondeo, la marca puede seguir en pantalla.
  if [ -z "$VISTO" ] && [ "$RC_PANEL" != 3 ]; then
    PANEL=$(ssh -o BatchMode=yes "$HOST" "bash -lc $(printf '%q' "\$HOME/.local/bin/cauce-panel $(printf '%q' "$A")")" 2>/dev/null)
    RC_PANEL=$?
    printf '%s' "$PANEL" | grep -qF "$MARCA" && VISTO=1
  fi
  echo

  case "$EST" in
    done) printf '  bus:   \033[32mdone\033[0m — respondio: %s\n' "$REPLY_TXT" ;;
    "")   printf '  bus:   \033[31mno pude leer el estado de la entrega\033[0m\n' ;;
    *)    printf '  bus:   \033[31m%s\033[0m — %s\n' "$EST" "$REPLY_TXT" ;;
  esac

  [ -n "$VISTO" ] && PANEL="$MARCA"
  if [ "$RC_PANEL" = 3 ]; then
    # openclaw no tiene panel tmux: su arnes es un servidor y la TUI del duenio es OTRO cliente de
    # la misma conversacion. Reportarlo como fallo seria decir lo contrario de la verdad.
    printf '  panel: \033[33mopenclaw no usa panel tmux\033[0m — su sesion compartida la da el gateway.\n'
    printf '         \033[2mcomprobalo con: cauce %s sesiones\033[0m\n' "$A"
  elif printf '%s' "$PANEL" | grep -qF "$MARCA"; then
    printf '  panel: \033[32mla marca %s aparece en la TUI compartida\033[0m\n' "$MARCA"
  elif [ -z "$PANEL" ]; then
    printf '  panel: \033[33mno hay panel que mirar\033[0m (alias sin sesion compartida, o TUI caida)\n'
  else
    printf '  panel: \033[31mla marca NO aparece en la TUI\033[0m — el turno no paso por el arnes\n'
    printf '%s\n' "$PANEL" | tail -6 | sed 's/^/         /'
  fi
  [ "$EST" = "done" ] || exit 1
  exit 0
fi

# `soltar` es un binario aparte en la torre, no un subcomando del CLI.
if [ "${1:-}" = soltar ]; then
  shift
  [ $# -ge 1 ] || { echo "uso: cauce soltar <alias>" >&2; exit 2; }
  exec ssh -t "$HOST" "bash -lc $(printf '%q' "\$HOME/.local/bin/cauce-soltar $(printf '%q ' "$@")")"
fi

# Sin argumentos o con subcomando de solo lectura no hace falta TTY; entrar SI lo necesita.
# Pedirlo siempre es mas simple y no molesta: ssh -t degrada solo si no hay terminal.
TTY=(-t)
[ -t 0 ] || TTY=()   # sin terminal local (tuberia, cron) no forzamos: evita el aviso de ssh

if [ $# -eq 0 ]; then
  exec ssh "${TTY[@]}" "$HOST" "bash -lc $(printf '%q' "$REMOTO")"
fi

# printf %q en cada argumento: kratos usa fish y sin esto los espacios y comillas se parten.
ARGS=$(printf '%q ' "$@")
exec ssh "${TTY[@]}" "$HOST" "bash -lc $(printf '%q' "$REMOTO $ARGS")"
