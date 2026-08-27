#!/usr/bin/env bash
# cauce — un solo CLI para operar la flota Cauce V3.
#
# Reemplaza a: ia, ia-ver, ia-tui, ia-tui-session, cauce-attach, cauce-estado.
# La regla: `cauce <alias>` hace LO CORRECTO sin que tengas que elegir entre variantes.
#
# ESTE FICHERO ES LA FUENTE. Se instala en kratos como ~/.local/bin/cauce
# mediante `ops/scripts/install-cauce-cli.sh`.
#
# MODO COMPARTIDA: `cauce <alias>` abre la TUI REAL del harness (claude o codex) dentro de una
# sesión tmux que el adaptador también usa para los turnos del bus. No es un cliente de línea que
# imita una TUI: es el binario de verdad, con su panel, sus /comandos y su historial.
set -uo pipefail
OPS=$HOME/.local/share/cauce-v3/ops
BIN=$HOME/.local/bin
CONFIG=$HOME/.config/cauce-v3/container-aliases
TMUX_SOCKET=cauce

c_reset=$'\033[0m'; c_b=$'\033[1m'; c_dim=$'\033[90m'
c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_cy=$'\033[36m'

alias_info() {  # $1=alias -> "tenant\troom\tcontenedor\tusuario\thome\tstate\tharness"
  PYTHONDONTWRITEBYTECODE=1 python3 "$OPS/scripts/container-alias-query.py" "$1" 2>/dev/null
}
todos_los_alias() {
  for f in "$CONFIG"/*.env; do
    [ -e "$f" ] || continue; basename "$f" .env
  done | sort
}
# kant no corre en contenedor: su unit es cauce-v3-host-<alias>.service. Sin este respaldo el CLI
# lo da por "parado" aunque este atendiendo entregas del bus.
adaptador_activo() {
  local e
  e=$(systemctl --user is-active "cauce-v3-container-$1.service" 2>/dev/null)
  if [ "$e" != active ] && systemctl --user cat "cauce-v3-host-$1.service" >/dev/null 2>&1; then
    systemctl --user is-active "cauce-v3-host-$1.service" 2>/dev/null
  else
    printf '%s\n' "$e"
  fi
}

# ¿El alias tiene ENCENDIDA la sesión compartida en su configuración?
# Es la única fuente de verdad: el mismo interruptor que lee el supervisor para el adaptador.
compartida_configurada() {
  [ -f "$CONFIG/$1.env" ] && grep -qx 'SHARED_SESSION=1' "$CONFIG/$1.env" && return 0
  # kant es host-native: no tiene contenedor y su interruptor vive en la UNIT, no en el .env.
  # Sin esta rama el CLI lo daba por "aparte" teniendo la sesion compartida encendida y andando.
  es_host_native "$1" && systemctl --user show "cauce-v3-host-$1.service" -p Environment --value 2>/dev/null \
    | tr ' ' '\n' | grep -qx 'CAUCE_SHARED_SESSION=1'
}

# ¿El adaptador de este alias corre en el HOST en vez de dentro de un contenedor?
es_host_native() {
  systemctl --user cat "cauce-v3-host-$1.service" >/dev/null 2>&1
}

# Ruta del helper de sesión compartida DENTRO del contenedor. Sale del bundle que el supervisor ya
# desplegó, así que el CLI y el adaptador corren exactamente el mismo código.
helper_en_contenedor() {  # $1=alias
  # kant es host-native: su bundle NO sale del .env (que miente, quedó en uno viejo) sino de la
  # ruta absoluta del ExecStart de su unit, y vive en el árbol del host, no en /opt del contenedor.
  if es_host_native "$1"; then
    systemctl --user cat "cauce-v3-host-$1.service" 2>/dev/null \
      | sed -n 's|^ExecStart=.*node \(.*\)/packages/adapter-sdk/dist/src/bin/.*|\1/packages/adapter-sdk/dist/src/bin/shared-session.js|p' \
      | head -1 | sed "s|^~|$HOME|; s|^%h|$HOME|"
    return 0
  fi
  local release
  release=$(sed -n 's/^BUNDLE_RELEASE=//p' "$CONFIG/$1.env" 2>/dev/null | head -1)
  [ -n "$release" ] || return 1
  printf '/opt/cauce-v3-adapter/%s/releases/%s/packages/adapter-sdk/dist/src/bin/shared-session.js\n' "$1" "$release"
}

# `ensure|status` de la sesión compartida, ejecutado dentro del contenedor como el usuario del alias.
sesion() {  # $1=accion $2=alias $3=contenedor $4=usuario $5=harness
  local helper ws
  helper=$(helper_en_contenedor "$2") || return 3
  if es_host_native "$2"; then
    [ -f "$helper" ] || return 3
    ws=$(systemctl --user show "cauce-v3-host-$2.service" -p Environment --value 2>/dev/null \
         | tr ' ' '\n' | sed -n 's/^CAUCE_SHARED_SESSION_WORKSPACE=//p' | head -1)
    node "$helper" "$1" --alias "$2" --harness "$5" --workspace "${ws:-$HOME}"
    return $?
  fi
  docker exec --user "$4" "$3" test -f "$helper" || return 3
  docker exec --user "$4" "$3" node "$helper" "$1" --alias "$2" --harness "$5" --workspace /workspace
}

# Los avisos de caída que quedaron registrados mientras el dueño no estaba mirando.
avisos() {  # $1=alias $2=contenedor $3=usuario $4=state $5=harness
  local helper
  helper=$(helper_en_contenedor "$1") || return 0
  if es_host_native "$1"; then
    node "$helper" degradations --alias "$1" --harness "$5" --state "$4" 2>/dev/null
    return 0
  fi
  docker exec --user "$3" "$2" node "$helper" degradations \
    --alias "$1" --harness "$5" --state "$4" 2>/dev/null
}

uso() {
  cat <<EOF
${c_b}cauce${c_reset} — operar la flota Cauce V3

  ${c_b}cauce${c_reset}                    estado de toda la flota
  ${c_b}cauce <alias>${c_reset}            entrar a hablarle (elige solo el mejor modo)
  ${c_b}cauce <alias> ver${c_reset}        mirar en vivo lo que le llega, sin entrar
  ${c_b}cauce <alias> estado${c_reset}     detalle de un agente
  ${c_b}cauce <alias> sesiones${c_reset}   que conversaciones tiene y cual comparte
  ${c_b}cauce <alias> on|off${c_reset}     encender / apagar su adaptador
  ${c_b}cauce ver [alias...]${c_reset}     mirar varios a la vez

Al entrar con ${c_b}cauce <alias>${c_reset} te dice en la cabecera cual de los tres modos te toco:
  ${c_ok}compartida${c_reset}  la TUI REAL del agente, y la MISMA conversacion que Telegram.
  ${c_warn}aparte${c_reset}      TUI real pero conversacion nueva: NO comparte con Telegram.
  ${c_err}exclusiva${c_reset}   el adaptador esta parado; lo de Telegram se encola.
EOF
}

# ---------- estado de la flota ----------
cmd_flota() {
  printf "\n  ${c_b}%-9s %-22s %-9s %-9s %-9s %s${c_reset}\n" ALIAS CONTENEDOR HARNESS ADAPTADOR TUI MODO
  printf "  %s\n" "$(printf '─%.0s' $(seq 1 76))"
  local a line ctr cuser harness ad modo color term
  local -a sin_gateway=()
  for a in $(todos_los_alias); do
    line=$(alias_info "$a") || continue
    IFS=$'\t' read -r _ _ ctr cuser _ _ harness _ <<<"$line"
    ad=$(adaptador_activo "$a")
    if compartida_configurada "$a" && sesion status "$a" "$ctr" "$cuser" "$harness" >/dev/null 2>&1; then
      modo=compartida; color=$c_ok; term="${c_ok}si${c_reset}"
    elif [[ $harness == openclaw ]] && openclaw_gateway_vivo "$ctr"; then
      # En openclaw la sesión compartida no tiene interruptor propio: la da el gateway. Si acepta
      # conexiones, la TUI y el turno del bus son dos clientes de la MISMA conversación.
      modo=compartida; color=$c_ok; term="${c_ok}si${c_reset}"
    elif [[ $harness == openclaw && $ad == active ]]; then
      # El caso que no se puede pintar como "aparte" sin mentir: el alias SIGUE contestando el bus,
      # pero por el camino embebido, dentro del propio puente. El dueño no ve NADA de eso, y hoy
      # nada se lo dice en el chat. Que al menos se lo diga acá, y en rojo.
      modo="SIN GATEWAY"; color=$c_err; term="${c_err}NO${c_reset}"; sin_gateway+=("$a")
    elif [[ $ad == active ]]; then
      modo=aparte; color=$c_warn; term="${c_dim}no${c_reset}"
    else
      modo="—"; color=$c_dim; term="${c_dim}no${c_reset}"
    fi
    [[ $ad == active ]] && ad="${c_ok}activo${c_reset}" || ad="${c_dim}parado${c_reset}"
    # El inventario sigue diciendo el contenedor de antes de la mudanza. Si el alias corre nativo en
    # la torre, decirlo: si no, alguien va a hacer docker exec en un contenedor donde no hay nada.
    local ctr_txt="$ctr"
    es_host_native "$a" && ctr_txt="torre (sin docker)"
    printf "  %-9s %-22s %-9s %-18s %-18s ${color}%s${c_reset}\n" "$a" "$ctr_txt" "$harness" "$ad" "$term" "$modo"
  done
  if [ ${#sin_gateway[@]} -gt 0 ]; then
    printf "\n  ${c_err}${c_b}SIN GATEWAY: %s${c_reset}\n" "${sin_gateway[*]}"
    printf "  ${c_dim}siguen contestando Telegram por el camino embebido, en una conversacion que vos NO ves.${c_reset}\n"
    printf "  ${c_dim}levantar:  systemctl --user start cauce-v3-openclaw-gateway@<alias>${c_reset}\n"
  fi
  printf "\n  ${c_dim}entrar:  cauce <alias>      mirar:  cauce <alias> ver${c_reset}\n\n"
}

# La clave de sesion que usa el bus para un alias openclaw: la entrada "openclaw:<alias>:" de su
# sessions.json. Hay que leerla en caliente porque es un randomUUID que cambia si se limpia el store.
# Las sesiones que Cauce le abrio a este alias, una por conversacion, enriquecidas con lo que
# sabe el gestor de sesiones de openclaw (edad, tokens) y con un adelanto del ultimo texto.
# Salida: una linea por sesion, "native_id<TAB>edad<TAB>tokens<TAB>adelanto<TAB>donde".
# "donde" sale del campo origin que el adaptador escribe junto al native_id (SDK >= 20260731).
# Las entradas viejas no lo tienen: esas dicen "sin origen" y NO se adivinan. Las de Telegram
# salen PRIMERAS para que el dueño no tenga que elegir a ciegas cual es la de su chat.
openclaw_sesiones() {  # $1=alias $2=contenedor $3=usuario $4=stateDirectory
  docker exec --user "$3" "$2" python3 -c '
import json, os, subprocess, sys
alias = sys.argv[1]
# El stateDirectory viene de container-alias-query.py: los alias
# openclaw lo tienen en <home>/.openclaw/cauce-v3/<alias>.
state = sys.argv[2]
home = os.path.expanduser("~")

# 1) las sesiones que Cauce le abrio a este alias, una por conversacion
try:
    with open("%s/sessions.json" % state) as fh:
        cauce = json.load(fh)
except Exception:
    raise SystemExit(0)

# De que conversacion vino cada sesion. El adaptador lo escribe al lado del native_id; el hash
# de la clave es irreversible, asi que este campo es la UNICA forma de saberlo desde afuera.
def donde_y_rango(v):
    o = v.get("origin")
    if not isinstance(o, dict):
        return ("sin origen (consola o publicacion)", 9)
    canal = o.get("channel") or o.get("adapter") or "?"
    conv = str(o.get("conversation_id") or "")
    if canal == "telegram":
        if conv.lstrip("-").isdigit() and not conv.startswith("-"):
            return ("DM Telegram %s" % conv, 0)
        return ("Grupo Telegram %s" % conv, 1)
    if conv.startswith("operator:"):
        return ("consola/publicacion (%s)" % conv.split(":", 1)[1], 3)
    if conv.startswith("agents:"):
        return ("agente-a-agente (tenant %s)" % conv.split(":", 1)[1], 4)
    return ("%s %s" % (canal, conv), 2)

mias = []
for k, v in (cauce.get("sessions") or {}).items():
    if not k.startswith("openclaw:%s:" % alias) or not (v or {}).get("native_id"):
        continue
    d, r = donde_y_rango(v)
    # El carril de agentes no es una conversacion del dueno: nunca puede quedar primero.
    # El prefijo va ADELANTE, no atras: la columna se trunca y un sufijo se perdia justo en las
    # filas mas largas, que son las que dicen "sin origen".
    if k.endswith(".agent-lane"):
        r = max(r, 5)
        d = "[agentes] %s" % d
    mias.append((r, v["native_id"], d))
if not mias:
    raise SystemExit(0)
mias.sort(key=lambda t: t[0])

# 2) lo que sabe el gestor de sesiones de openclaw: edad, tokens, y el id del transcript
porclave = {}
try:
    out = subprocess.run(["openclaw", "sessions", "list", "--json", "--limit", "all"],
                         capture_output=True, text=True, timeout=25).stdout
    lista = json.loads(out)
    if isinstance(lista, dict):
        lista = lista.get("sessions") or lista.get("items") or []
    for s in lista:
        k = s.get("key", "")
        if ":" in k:
            porclave[k.rsplit(":", 1)[-1]] = s
except Exception:
    pass

def edad(ms):
    if not ms: return "?"
    m = ms // 60000
    if m < 60: return "%dm" % m
    if m < 1440: return "%dh" % (m // 60)
    return "%dd" % (m // 1440)

# 3) el ultimo turno del DUEÑO identifica la conversacion mejor que la respuesta. En la del bus
#    ese turno es el sobre de protocolo entero, asi que se extrae el pedido real de adentro.
def adelanto(sid):
    if not sid: return ""
    f = "%s/.openclaw/agents/main/sessions/%s.jsonl" % (home, sid)
    if not os.path.exists(f): return ""
    ult = ""
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            for ln in fh:
                try: e = json.loads(ln)
                except Exception: continue
                m = e.get("message") or {}
                if m.get("role") != "user": continue
                c = m.get("content")
                if isinstance(c, list):
                    c = " ".join(x.get("text", "") for x in c
                                 if isinstance(x, dict) and x.get("type") == "text")
                if isinstance(c, str) and c.strip(): ult = c.strip()
    except Exception:
        return ""
    for ini_m, fin_m in (("BEGIN REQUEST", "END REQUEST"), ("BEGIN IDENTITY", "END IDENTITY")):
        if ini_m in ult and fin_m in ult:
            ult = ult.split(ini_m, 1)[1].split(fin_m, 1)[0]
            break
    return " ".join(ult.split()).strip("- ")[:64]

for _r, n, d in mias:
    s = porclave.get(n, {})
    tok = "%dk" % (s.get("totalTokens", 0) // 1000) if s.get("totalTokens") else "?"
    print("%s\t%s\t%s\t%s\t%s" % (n, edad(s.get("ageMs")), tok, adelanto(s.get("sessionId")), d))
' "$1" "$4" 2>/dev/null
}

# El gateway de openclaw acepta conexiones? Sin el no hay a que engancharse: el alias corre por
# el fallback embebido dentro del propio puente y la TUI no comparte nada.
openclaw_gateway_vivo() {  # $1=contenedor
  docker exec "$1" node -e '
const net=require("net"), fs=require("fs");
// El puerto NO es siempre 18789: sale de gateway.port de openclaw.json (janus usa 18790).
let puerto=18789;
for (const p of ["/home/claw/.openclaw/openclaw.json","/home/dev/.openclaw/openclaw.json"]) {
  try { const g=(JSON.parse(fs.readFileSync(p,"utf8")).gateway)||{}; if (g.port) { puerto=g.port; break; } } catch (e) {}
}
const s=net.connect(puerto,"127.0.0.1");
s.setTimeout(2500);
s.on("connect",()=>{s.destroy();process.exit(0)});
s.on("error",()=>process.exit(1));
s.on("timeout",()=>process.exit(1));
' >/dev/null 2>&1
}

# ---------- entrar ----------
cmd_entrar() {
  local a=$1 line ctr cuser chome state harness ad salida
  line=$(alias_info "$a") || { echo "alias desconocido: $a"; exit 2; }
  IFS=$'\t' read -r _ _ ctr cuser chome state harness _ <<<"$line"
  ad=$(adaptador_activo "$a")

  printf "\n  ${c_b}%s${c_reset} · %s · %s\n" "$a" "$harness" "$ctr"

  # 1) sesion compartida: la TUI real, y la misma conversacion que Telegram.
  if compartida_configurada "$a"; then
    salida=$(sesion ensure "$a" "$ctr" "$cuser" "$harness" 2>&1)
    if [[ $? -eq 0 ]]; then
      printf "  modo: ${c_ok}${c_b}COMPARTIDA${c_reset} — la TUI real, y la misma conversacion que Telegram.\n"
      printf "  ${c_dim}lo que llegue por el bus aparece aca EN VIVO. salir sin cerrarla: Ctrl-b d${c_reset}\n"
      # Lo que se rompio mientras no estabas mirando. Si el bus tuvo que contestar por el camino
      # de siempre, se dice aca ANTES de entrar: una caida silenciosa es indistinguible del exito.
      local pendientes
      pendientes=$(avisos "$a" "$ctr" "$cuser" "$state" "$harness")
      if [ -n "$pendientes" ]; then
        printf "\n  ${c_err}${c_b}avisos de la sesion compartida:${c_reset}\n"
        printf '%s\n' "$pendientes" | python3 -c '
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: r=json.loads(line)
    except Exception: continue
    print("    \033[31m•\033[0m %s  %s: %s" % (r.get("occurredAt","")[:19], r.get("reason","?"), r.get("detail","")))
'
      fi
      printf "\n"
      if es_host_native "$a"; then
        # Su tmux es el del HOST: entrar por docker exec no lleva a ninguna parte.
        exec tmux -L "$TMUX_SOCKET" attach-session -t "cauce-$a:agente"
      fi
      exec docker exec -it --user "$cuser" "$ctr" \
        tmux -L "$TMUX_SOCKET" attach-session -t "cauce-$a:agente"
    fi
    # El interruptor esta encendido pero la sesion no se pudo abrir. Se DICE, y se cae a lo de
    # siempre: exactamente lo contrario del fallback silencioso que mato al intento anterior.
    printf "  ${c_err}la sesion compartida esta configurada pero NO se pudo abrir:${c_reset}\n"
    printf "  ${c_dim}%s${c_reset}\n" "${salida:-sin detalle}"
  elif [[ $harness == openclaw ]]; then
    local lineas clave_oc n
    mapfile -t lineas < <(openclaw_sesiones "$a" "$ctr" "$cuser" "$state")
    if [[ ${#lineas[@]} -eq 0 ]]; then
      printf "  ${c_dim}todavia no hay ninguna sesion del bus para %s: mandale algo y volve${c_reset}\n" "$a"
    elif ! openclaw_gateway_vivo "$ctr"; then
      printf "  ${c_err}el gateway de openclaw NO responde en %s (127.0.0.1:18789)${c_reset}\n" "$ctr"
      printf "  ${c_dim}sin gateway no hay a que engancharse: este alias corre por el camino embebido,${c_reset}\n"
      printf "  ${c_dim}dentro del propio puente, asi que una TUI aca seria una conversacion aparte.${c_reset}\n"
    else
      local donde_oc
      if [[ ${#lineas[@]} -gt 1 ]]; then
        # openclaw abre una conversacion por canal (Telegram, consola, bus). No son un error:
        # son hilos distintos de verdad, y el dueño elige a cual entra. Las de Telegram van
        # primeras y marcadas: es la que el dueño casi siempre quiere y hasta hoy tenia que
        # adivinar, porque todas se listaban igual.
        printf "  ${c_b}%s conversaciones${c_reset} ${c_dim}— openclaw abre una por canal. Elegi:${c_reset}\n\n" "${#lineas[@]}"
        local hay_dm=0
        for i in "${!lineas[@]}"; do
          IFS=$'\t' read -r nid ed tk pre dnd <<<"${lineas[$i]}"
          local marca="  " color="$c_dim"
          if [[ $dnd == DM\ Telegram* ]]; then marca="${c_ok}${c_b}>>${c_reset}"; color="$c_ok"; hay_dm=1; fi
          printf "  %s ${c_b}%d)${c_reset} %-9s ${color}%-40s${c_reset} ${c_dim}hace %-5s · %-5s${c_reset}  %s\n" \
            "$marca" $((i+1)) "${nid:0:8}" "${dnd:0:40}" "$ed" "$tk" "${pre:0:38}"
        done
        # La leyenda sólo si hay algo que señalar. Un ">>" explicado y ausente hace buscar una
        # marca que no existe, y deja la duda de si la conversacion de Telegram esta o no.
        if [[ $hay_dm -eq 1 ]]; then
          printf "\n  ${c_dim}>> = el DM de Telegram del dueño, segun lo que el adaptador anoto al abrirla.${c_reset}\n"
        else
          printf "\n  ${c_warn}ninguna conversacion consta como DM de Telegram.${c_reset}${c_dim} Las que dicen \"sin origen\"\n"
          printf "  son anteriores al registro de origen: puede que una lo sea, pero no puedo decir cual.${c_reset}\n"
        fi
        printf "  ${c_dim}numero (Enter = 1, q = salir):${c_reset} "
        read -r n </dev/tty || n=""
        [[ $n == q ]] && { printf "\n"; exit 0; }
        [[ -z $n ]] && n=1
        if ! [[ $n =~ ^[0-9]+$ ]] || (( n < 1 || n > ${#lineas[@]} )); then
          printf "  ${c_err}opcion invalida${c_reset}\n\n"; exit 2
        fi
      else
        n=1
      fi
      IFS=$'\t' read -r clave_oc _ _ _ donde_oc <<<"${lineas[$((n-1))]}"
      # El cartel dice QUE conversacion es, no solo que "es la misma que el bus". Cuando el
      # origen no consta, se dice que no consta: afirmar que es la de Telegram sin poder
      # comprobarlo es justo lo que hacia el cartel anterior.
      printf "\n  modo: ${c_ok}${c_b}COMPARTIDA${c_reset} — la TUI real de openclaw, la MISMA conversacion que el bus.\n"
      if [[ $donde_oc == *"sin origen"* || -z $donde_oc ]]; then
        printf "  ${c_warn}conversacion: NO CONSTA de que canal salio${c_reset}${c_dim} (entrada anterior al registro de origen).\n"
        printf "  no puedo afirmar que sea la de Telegram; si no es, salí y elegí otra.${c_reset}\n"
      else
        printf "  ${c_dim}conversacion: %s${c_reset}\n" "$donde_oc"
      fi
      printf "  ${c_dim}salir sin cerrarla: Ctrl-b d  ·  sesion %s${c_reset}\n" "${clave_oc:0:8}"
      printf "  ${c_warn}ojo, openclaw todavia NO esta endurecido${c_reset}${c_dim} — tres cosas medidas:\n"
      printf "    · el PEDIDO del bus no se pinta en vivo (la respuesta si): veras respuestas sin pregunta\n"
      printf "    · veras el sobre JSON crudo y el prompt de protocolo entero\n"
      printf "    · el agente NO recuerda lo que EL te contesto a vos (lo que vos escribis si lo ve)${c_reset}\n\n"
      exec docker exec -it --user "$cuser" -w "${chome:-/}" "$ctr" openclaw tui --session "$clave_oc"
    fi
  elif [[ $harness == claude || $harness == codex ]]; then
    printf "  ${c_dim}este alias no tiene sesion compartida encendida (falta SHARED_SESSION=1 en su .env)${c_reset}\n"
  else
    printf "  ${c_dim}el harness %s no tiene sesion compartida${c_reset}\n" "$harness"
  fi

  # 2) conversacion aparte, sin parar al agente
  if [[ $ad == active ]]; then
    printf "  modo: ${c_warn}${c_b}APARTE${c_reset} — TUI real, pero conversacion nueva: NO comparte con Telegram.\n"
    printf "  ${c_dim}el agente sigue respondiendo Telegram y el bus. salir: Ctrl-D${c_reset}\n\n"
    case "$harness" in
      claude) exec docker exec -it --user "$cuser" -w /workspace "$ctr" claude ;;
      codex)  exec docker exec -it --user "$cuser" -w /workspace "$ctr" codex ;;
      openclaw)
              printf "  ${c_dim}openclaw SI tiene TUI propia, pero no te la abro aca: en modo local${c_reset}\n"
              printf "  ${c_dim}comparte el ESTADO con el bus y aun asi el panel es CIEGO (el turno del${c_reset}\n"
              printf "  ${c_dim}bus nunca aparece). La conversacion mutaria debajo tuyo sin dejar rastro.${c_reset}\n"
              printf "  ${c_dim}Te abro un shell; para la TUI compartida hace falta gateway.${c_reset}\n\n"
              exec docker exec -it --user "$cuser" -w "${chome:-/}" "$ctr" bash -l ;;
      *)      printf "  ${c_dim}sin TUI propia: te abro un shell${c_reset}\n\n"
              exec docker exec -it --user "$cuser" -w /workspace "$ctr" bash -l ;;
    esac
  fi

  # 3) el adaptador esta parado: attach exclusivo clasico
  printf "  modo: ${c_err}${c_b}EXCLUSIVA${c_reset} — su adaptador esta parado.\n"
  printf "  ${c_dim}lo que le escriban por Telegram se ENCOLA y entra cuando salgas.${c_reset}\n\n"
  if [[ -x $BIN/cauce-attach ]]; then exec python3 "$BIN/cauce-attach" "$a"; fi
  exec docker exec -it --user "$cuser" -w /workspace "$ctr" bash -l
}

# ---------- resto ----------
cmd_ver()      { exec "$BIN/ia-ver" "$@"; }
cmd_estado()   { [ $# -eq 0 ] && exec "$BIN/ia" estado || exec "$BIN/ia" "$1" estado; }
cmd_sesiones() { exec "$BIN/ia" "$1" sesiones; }
# La unit de verdad. kant no tiene "container-": es host-native. Preguntarle a la unit equivocada
# devuelve "inactive" para un alias que esta perfectamente vivo.
unit_del_alias() {
  es_host_native "$1" && printf 'cauce-v3-host-%s.service\n' "$1" || printf 'cauce-v3-container-%s.service\n' "$1"
}

# Los PIDs que llevan CAUCE_ALIAS=<alias>, mirados donde de verdad corren. Esta es la unica senal
# que no miente: systemd dijo "inactive" sobre un adaptador que siguio 3h27m con su socket al bus,
# porque el supervisor NUNCA senala a un proceso que no rastrea ("no signal was sent").
# Ojo con el barrido: tiene que correr DENTRO del contenedor. Correrlo en el host lee un /proc que
# no es el suyo, no encuentra nada y sale con codigo 0.
# Los PIDs del adaptador, mirados donde de verdad corren. Dos criterios, porque cada uno solo
# falla en la mitad de los casos:
#   - environ CAUCE_ALIAS=<alias>: unico que sirve para kant (host-native), pero ILEGIBLE en los
#     contenedores no privilegiados. Medido: root dentro de `claw` lee 2 de 23 environs, porque
#     Docker no concede CAP_SYS_PTRACE. Confiar solo en esto devuelve vacio con codigo 0.
#   - cmdline con /cauce-v3-adapter/<alias>/: world-readable SIEMPRE. Es el que salva el caso de
#     arriba. Deja fuera al agente PTY (/var/tmp/cauce-pty-agent-<alias>.py) a proposito: ese es
#     otro canal, con su propia unit, y "off" no habla de el.
# El placeholder NO puede llamarse ALIAS: esa cadena vive dentro de CAUCE_ALIAS= y la sustitucion
# se comeria el propio sed.
BARRIDO='for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null); set -- $c; case "${1:-}" in *node*|*python*) ;; *) continue;; esac; h=""; e=$(tr "\0" "\n" < "$p/environ" 2>/dev/null | sed -n "s/^CAUCE_ALIAS=//p" | head -1); [ "$e" = "@@A@@" ] && h=1; case "$c" in *cauce-v3-adapter/@@A@@/*) h=1;; esac; [ -n "$h" ] && echo "${p#/proc/}"; done'

pids_del_alias() {  # $1=alias -> un PID por linea (vacio = de verdad no hay nada)
  local a=$1 line ctr cuser
  if es_host_native "$a"; then
    eval "${BARRIDO//@@A@@/$a}" 2>/dev/null
    return 0
  fi
  line=$(alias_info "$a") || return 0
  IFS=$'\t' read -r _ _ ctr cuser _ _ _ <<<"$line"
  [ -n "$ctr" ] || return 0
  docker exec "$ctr" sh -c "${BARRIDO//@@A@@/$a}" 2>/dev/null
}

cmd_on() {
  local a=$1 u; u=$(unit_del_alias "$a")
  systemctl --user start "$u" || true
  sleep 6
  # Tres comprobaciones independientes, porque cada una sola ya mintio alguna vez.
  local pids tui line ctr cuser harness
  pids=$(pids_del_alias "$a" | tr '\n' ' ')
  line=$(alias_info "$a") && IFS=$'\t' read -r _ _ ctr cuser _ _ harness <<<"$line"
  if [ -z "${pids// /}" ]; then
    printf "  ${c_err}%s NO arranco${c_reset}  (systemd dice: %s)\n" "$a" "$(adaptador_activo "$a")"
    printf "  ${c_dim}journalctl --user -u %s -n 30 --no-pager${c_reset}\n" "$u"
    return 1
  fi
  printf "  %s proceso vivo: ${c_ok}%s procesos${c_reset} ${c_dim}(PID %s...)${c_reset}\n" \
    "$a" "$(printf '%s\n' $pids | grep -c .)" "$(printf '%s' "$pids" | cut -d" " -f1)"
  if compartida_configurada "$a"; then
    # Arrancar el adaptador no crea la TUI: la sesion se crea aparte, y sin ella el preflight
    # deja al alias en tui_absent. Crearla aca es lo que hace que "on" quiera decir encendido.
    sesion ensure "$a" "$ctr" "$cuser" "$harness" >/dev/null 2>&1 || true
    if tui=$(sesion status "$a" "$ctr" "$cuser" "$harness" 2>&1) && \
       printf '%s' "$tui" | grep -q '"present":true'; then
      printf "  %s sesion compartida: ${c_ok}lista${c_reset}\n" "$a"
    else
      printf "  ${c_err}%s arranco SIN sesion compartida${c_reset} — Telegram y tu TUI quedan separados\n" "$a"
      printf "  ${c_dim}%s${c_reset}\n" "$(printf '%s' "$tui" | tail -2)"
    fi
  fi
  printf "  ${c_dim}entrar: cauce %s${c_reset}\n" "$a"
}

cmd_off() {
  local a=$1 u; u=$(unit_del_alias "$a")
  systemctl --user stop "$u" || true
  sleep 3
  # No alcanza con parar la unit: hay un caso medido donde el alias siguio contestando el bus con
  # la unit en "inactive". Si sobrevivio algo, matarlo — "off" quiere decir off.
  local pids p vivo
  pids=$(pids_del_alias "$a")
  if [ -n "$pids" ]; then
    printf "  ${c_warn}%s sobrevivio a systemd${c_reset} (PID %s) — lo mato\n" "$a" "$(echo "$pids" | tr '\n' ' ')"
    for p in $pids; do
      # Reconfirmar la identidad JUSTO antes de senalar: los PIDs se reciclan.
      if es_host_native "$a"; then
        vivo=$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | sed -n 's/^CAUCE_ALIAS=//p' | head -1)
        [ "$vivo" = "$a" ] && kill "$p" 2>/dev/null
      else
        local line ctr; line=$(alias_info "$a") && IFS=$'\t' read -r _ _ ctr _ _ _ _ <<<"$line"
        vivo=$(docker exec "$ctr" sh -c "tr '\0' '\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^CAUCE_ALIAS=//p' | head -1" 2>/dev/null)
        [ "$vivo" = "$a" ] && docker exec "$ctr" kill "$p" 2>/dev/null
      fi
    done
    sleep 2
    pids=$(pids_del_alias "$a")
  fi
  if [ -n "$pids" ]; then
    printf "  ${c_err}%s SIGUE VIVO${c_reset} (PID %s). No se murio solo: mirar a mano.\n" "$a" "$(echo "$pids" | tr '\n' ' ')"
    return 1
  fi
  # Su servidor tmux arrastra la generacion del adaptador: si queda en pie, el proximo arranque
  # muere con 78/CONFIG ("untracked processes still carry this alias generation").
  # Matar la sesion tmux NO basta: el proceso del arnes puede sobrevivir sin panel y quedar
  # huerfano, durmiendo en epoll con su session id tomado. Medido: un `claude --resume <uuid>`
  # sobrevivio 51 min a un `off`, y un session id retenido es justo lo que produce los
  # dead_letters de "Session ID ... is already in use". Hay que anotar el PID del panel ANTES de
  # matar la sesion, porque despues ya no hay a quien preguntarle.
  local matar_panel="pids=$(tmux -L $TMUX_SOCKET list-panes -t cauce-$a -F \"#{pane_pid}\" 2>/dev/null); tmux -L $TMUX_SOCKET kill-session -t cauce-$a 2>/dev/null; for p in \$pids; do kill \$p 2>/dev/null; done; true"
  if es_host_native "$a"; then
    sh -lc "$matar_panel" >/dev/null 2>&1
  else
    local line2 ctr2; line2=$(alias_info "$a") && IFS=$'\t' read -r _ _ ctr2 _ _ _ _ <<<"$line2"
    [ -n "$ctr2" ] && docker exec "$ctr2" sh -lc "$matar_panel" >/dev/null 2>&1
  fi
  printf "  %s ${c_ok}adaptador del bus apagado de verdad${c_reset} ${c_dim}(su TUI tambien se fue, si no el proximo \"on\" falla con 78/CONFIG)${c_reset}\n" "$a"
  # "off" apaga el ADAPTADOR DEL BUS. El canal PTY es otro servicio, con su propia unit, y sigue
  # en pie: el alias mantiene una conexion TLS abierta al relay de agora y su terminal web sigue
  # alcanzable. Creer que "off" apaga al alias entero es concluir lo contrario de la verdad.
  if [ "$(systemctl --user is-active "cauce-v3-pty@$a.service" 2>/dev/null)" = active ]; then
    printf "  ${c_warn}ojo:${c_reset} su agente PTY sigue vivo y conectado al relay ${c_dim}(cauce-v3-pty@%s)${c_reset}\n" "$a"
    printf "        ${c_dim}el terminal web de %s sigue en pie. Para bajarlo tambien:${c_reset}\n" "$a"
    printf "        ${c_dim}systemctl --user stop cauce-v3-pty@%s${c_reset}\n" "$a"
  fi
}

case "${1:-}" in
  ""|flota|estado) [[ ${1:-} == estado ]] && cmd_estado "${2:-}" || cmd_flota ;;
  -h|--help|help|ayuda) uso ;;
  ver) shift; cmd_ver "$@" ;;
  *)
    a=$1; shift || true
    case "${1:-}" in
      "")        cmd_entrar "$a" ;;
      ver)       cmd_ver "$a" ;;
      estado)    cmd_estado "$a" ;;
      sesiones)  cmd_sesiones "$a" ;;
      on)        cmd_on "$a" ;;
      off)       cmd_off "$a" ;;
      *)         echo "no entiendo '$1'"; uso; exit 2 ;;
    esac ;;
esac
