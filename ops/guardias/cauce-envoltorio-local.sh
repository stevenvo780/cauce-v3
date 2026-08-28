#!/usr/bin/env bash
# cauce — local wrapper: run the real `cauce`, which lives on the tower, without typing
# ssh by hand.
# Why it exists: the real CLI is on the tower and needs to be there (talks to docker and
# to the container tmux sessions). From the laptop you'd otherwise have to remember both
# `ssh tower` AND `bash -lc`, and quoting breaks against fish on some hosts.
# Usage: cauce                  list the fleet
#        cauce <alias>          enter the session (interactive, needs TTY)
#        cauce <alias> ver      peek without touching
#        cauce <alias> sesiones which conversations it has and which it shares
#        cauce <alias> on|off   start / stop its adapter, with real verification
#        cauce probar <alias>   REAL delivery via the gateway + the marker on the panel
#        cauce soltar <alias>   release the tmux pane latch
set -uo pipefail

HOST=${CAUCE_HOST:-kratos}
REMOTO=${CAUCE_REMOTO:-\$HOME/.local/bin/cauce}

# `probar` cannot live on the tower: publishing to the bus needs the console client
# certificate, which sits on the orchestrator host, and the tower cannot reach it. The
# laptop can reach both, so the probe is orchestrated from here.
# What it checks, and why all three: publish a REAL delivery via the gateway (mTLS), wait
# for the row to reach a terminal state, and ALSO look at the tmux panel. All three are
# necessary: a `done` delivery does not prove the turn went through the TUI (fan-in
# synthesizes it locally via the SDK, without touching the harness), and a panel with
# text on it does not prove the bus saw the delivery.
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

  # The ACK deadline in production is 30 MINUTES: a stuck delivery does not fail fast — it
  # looks like a mute agent. Hence the wait with a ceiling and a report of how long we
  # waited.
  # And the panel must be checked WHILE the turn runs, not after: the claude TUI keeps
  # history_size=0 on an alt screen, so `capture-pane` only sees the CURRENT screen. When
  # the turn ends, the screen redraws and the marker disappears — checking only at the end
  # would report "turn never went through the harness" for a turn that did.
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
  # One last look: if the turn outran the polling, the marker may still be on screen.
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
    # openclaw has no tmux panel: its harness is a server and the owner's TUI is ANOTHER
    # client of the same conversation. Reporting this as a failure would be the opposite of
    # the truth.
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

# `soltar` is a separate binary on the tower, not a subcommand of the CLI.
if [ "${1:-}" = soltar ]; then
  shift
  [ $# -ge 1 ] || { echo "uso: cauce soltar <alias>" >&2; exit 2; }
  exec ssh -t "$HOST" "bash -lc $(printf '%q' "\$HOME/.local/bin/cauce-soltar $(printf '%q ' "$@")")"
fi
# With no args or a read-only subcommand, no TTY is needed; entering does. Always
# requesting it is simpler and harmless: ssh -t degrades by itself when there is no
# terminal.

TTY=(-t)
[ -t 0 ] || TTY=()   # no local terminal (pipe, cron): don't force it; avoids the ssh warning

if [ $# -eq 0 ]; then
  exec ssh "${TTY[@]}" "$HOST" "bash -lc $(printf '%q' "$REMOTO")"
fi

# printf %q on every argument: spaces and quotes get split otherwise on fish-based hosts.
ARGS=$(printf '%q ' "$@")
exec ssh "${TTY[@]}" "$HOST" "bash -lc $(printf '%q' "$REMOTO $ARGS")"
