# shellcheck shell=bash
codex_home_de() {  # $1=alias $2=home-del-usuario
  local h
  h=$(sed -n 's/^CREDENTIAL_HOME=//p' "$CONFIG/$1.env" 2>/dev/null | head -1)
  printf '%s\n' "${h:-$2/.codex}"
}

# CREDENTIAL_HOME applies only to plain Claude aliases, matching credencial_env_de.
# Other harnesses use the default Claude credential directory.
claude_home_de() {  # $1=alias $2=home-del-usuario $3=harness
  local h=
  [ "$3" = claude ] && h=$(sed -n 's/^CREDENTIAL_HOME=//p' "$CONFIG/$1.env" 2>/dev/null | head -1)
  printf '%s\n' "${h:-$2/.claude}"
}

# Read credentials on the alias host; host-native aliases have no container.
leer_en_alias() {  # $1=alias $2=contenedor $3=usuario $4=ruta
  if es_host_native "$1"; then cat "$4" 2>/dev/null
  else docker exec --user "$3" "$2" cat "$4" 2>/dev/null; fi
}
existe_en_alias() {  # $1=alias $2=contenedor $3=usuario $4=ruta
  if es_host_native "$1"; then [ -f "$4" ]
  else docker exec --user "$3" "$2" test -f "$4" 2>/dev/null; fi
}

# Renewal requires the provider CLI in the runtime; a credential file does not prove the binary exists.
# OpenClaw can declare both providers while its runtime contains only one CLI.
binario_en_alias() {  # $1=alias $2=contenedor $3=usuario $4=binario
  if es_host_native "$1"; then command -v "$4" >/dev/null 2>&1
  else docker exec --user "$3" "$2" sh -lc "command -v $4" >/dev/null 2>&1; fi
}

# Verify the alias runtime before reading credentials so a missing remote mount is not reported as empty.
contenedor_alcanzable() {  # $1=alias $2=contenedor
  es_host_native "$1" && return 0
  [ -n "$2" ] || return 1
  docker inspect -f '{{.State.Running}}' "$2" 2>/dev/null | grep -qx true
}

# Report credential type and a short fingerprint without exposing token contents.
# The fingerprint verifies whether login changed the credential file.
huella_claude() {  # $1=alias $2=contenedor $3=usuario $4=CONFIG-DIR de claude (el que sale de claude_home_de)
  leer_en_alias "$1" "$2" "$3" "$4/.credentials.json" | python3 -c '
import json,sys,hashlib
try: o=(json.load(sys.stdin).get("claudeAiOauth") or {})
except Exception: print("sin fichero legible|-"); raise SystemExit
a=o.get("accessToken") or ""; r=o.get("refreshToken") or ""
print("%s|%s" % ("oauth" if r else ("setup-token" if a else "VACIA"),
                 hashlib.sha256(a.encode()).hexdigest()[:12] if a else "-"))' 2>/dev/null \
  || printf 'no pude leerla|-\n'
}
huella_codex() {  # $1=alias $2=contenedor $3=usuario $4=codex-home
  leer_en_alias "$1" "$2" "$3" "$4/auth.json" | python3 -c '
import json,sys,base64
try: d=json.load(sys.stdin)
except Exception: print("sin fichero legible|-|"); raise SystemExit
t=d.get("tokens") or {}
em=""
try:
    p=(t.get("id_token") or "").split(".")[1]; p+="="*(-len(p)%4)
    em=json.loads(base64.urlsafe_b64decode(p)).get("email","")
except Exception: pass
print("%s|%s|%s" % ("ok" if (t.get("access_token") or d.get("OPENAI_API_KEY")) else "VACIA",
                    (t.get("account_id") or "?")[:13], em))' 2>/dev/null \
  || printf 'no pude leerla|-|\n'
}

pinta_credencial() {  # $1=que(claude|codex) $2=alias $3=ctr $4=usu $5=ruta-base
  local tipo huella cuenta correo
  if [ "$1" = claude ]; then
    IFS='|' read -r tipo huella <<<"$(huella_claude "$2" "$3" "$4" "$5")"
    printf "  Claude : %-14s %shuella=%s%s\n" "$tipo" "$c_dim" "$huella" "$c_reset"
  else
    IFS='|' read -r tipo cuenta correo <<<"$(huella_codex "$2" "$3" "$4" "$5")"
    printf "  Codex  : %-14s %scuenta=%s %s%s\n" "$tipo" "$c_dim" "$cuenta" "$correo" "$c_reset"
  fi
}

# An unmatched delivery_start marks a bus turn in progress; do not stop the alias during that turn.
turno_en_vuelo() {  # $1=alias -> 0 = SI hay turno en vuelo
  local ultimo
  ultimo=$(journalctl --user -u "$(unit_del_alias "$1")" -n 400 --no-pager -o cat 2>/dev/null \
           | grep -oE '"event":"delivery_(start|end)"' | tail -1)
  [[ $ultimo == *delivery_start* ]]
}

# Provider choices follow the declared harness; OpenClaw can declare both providers.
# cmd_login filters those choices by the CLI binaries installed in the runtime.
objetivos_declarados() {  # $1=harness $2=alias $3=ctr $4=usu $5=cfgdir-claude $6=codexhome
  case "$1" in
    claude) printf 'claude\n' ;;
    codex)  printf 'codex\n' ;;
    openclaw) printf 'claude\ncodex\n' ;;
    *)  # arnes que no conocemos: se ofrece lo que el contenedor REALMENTE tiene
        existe_en_alias "$2" "$3" "$4" "$5/.credentials.json" && printf 'claude\n'
        existe_en_alias "$2" "$3" "$4" "$6/auth.json" && printf 'codex\n'
        ;;
  esac
}

# setup-token prints a token without writing the credential file.
# Include scopes so Claude's auth status recognizes the credential.
instala_token_claude() {  # $1=alias $2=ctr $3=usu $4=cfgdir ; el TOKEN entra por STDIN
  local json
  # Read the token from stdin so it is not exposed in process arguments.
  json=$(python3 -c '
import json,sys,time
t=sys.stdin.read().strip()
if not t: raise SystemExit(9)
print(json.dumps({"claudeAiOauth":{"accessToken":t,"refreshToken":"",
  "expiresAt":int(time.time()*1000)+31536000000,
  "scopes":["user:inference","user:profile"],"subscriptionType":"max"}}))') || return 9
  [ -n "$json" ] || return 9
  # Replace the credential atomically so readers cannot observe partial JSON.
  if es_host_native "$1"; then
    ( umask 077; mkdir -p "$4" \
      && printf '%s' "$json" > "$4/.credentials.json.nuevo" \
      && chmod 600 "$4/.credentials.json.nuevo" \
      && mv -f "$4/.credentials.json.nuevo" "$4/.credentials.json" )
  else
    printf '%s' "$json" | docker exec -i --user "$3" -e CD="$4" "$2" sh -c '
      umask 077; mkdir -p "$CD" \
      && cat > "$CD/.credentials.json.nuevo" \
      && chmod 600 "$CD/.credentials.json.nuevo" \
      && mv -f "$CD/.credentials.json.nuevo" "$CD/.credentials.json"'
  fi
}

# Verify authentication through the provider CLI; file existence alone is insufficient.
estado_auth_claude() {  # $1=alias $2=ctr $3=usu $4=cfgdir
  if es_host_native "$1"; then
    CLAUDE_CONFIG_DIR="$4" claude auth status --text 2>&1 | head -2
  else
    docker exec --user "$3" -e CLAUDE_CONFIG_DIR="$4" "$2" claude auth status --text 2>&1 | head -2
  fi
}

login_claude() {  # $1=alias $2=ctr $3=usu $4=cfgdir de claude
  local opcion token
  printf "\n  %sComo funciona esto de verdad:%s %sclaude setup-token%s SOLO IMPRIME un token.\n" "$c_warn" "$c_reset" "$c_b" "$c_reset"
  printf "  %sNo escribe ninguna credencial en ningun sitio. Si lo dejas en pantalla, se pierde.%s\n" "$c_dim" "$c_reset"
  printf "  %sEste CLI lo instala por vos en %s/.credentials.json,%s\n" "$c_dim" "$4" "$c_reset"
  printf "  %sque es EXACTAMENTE el fichero que comprueba despues.%s\n" "$c_dim" "$c_reset"
  printf "\n  %s1)%s generar un token nuevo    %s(lanza 'claude setup-token' y luego lo instalo)%s\n" "$c_b" "$c_reset" "$c_dim" "$c_reset"
  printf "  %s2)%s pegar uno que ya tengas   %s(sk-ant-oat01-...; no gasta uno nuevo)%s\n" "$c_b" "$c_reset" "$c_dim" "$c_reset"
  read -r -p "  opcion [1/2]: " opcion
  if [ "${opcion:-1}" != 2 ]; then
    printf "\n  %s-- 'claude setup-token' dentro de %s: abri la URL, autoriza, y COPIA el token --%s\n\n" "$c_dim" "$2" "$c_reset"
    if es_host_native "$1"; then claude setup-token
    else docker exec -it --user "$3" "$2" claude setup-token; fi
    printf "\n  %sEse token de arriba TODAVIA NO esta instalado.%s Pegalo aca y lo instalo.\n" "$c_warn" "$c_reset"
  fi
  printf "  Pega el token y ENTER %s(no se muestra)%s: " "$c_dim" "$c_reset"
  read -r -s token; printf '\n'
  # Keep the existing credential when a replacement cannot be verified.
  if [ -z "$token" ]; then
    printf "  %stoken vacio: no toco nada%s %s(la credencial anterior sigue como estaba)%s\n" "$c_warn" "$c_reset" "$c_dim" "$c_reset"
    return 1
  fi
  case "$token" in
    *[[:space:]]*)
      printf "  %seso lleva espacios o saltos de linea: no es el token. No toco nada.%s\n" "$c_err" "$c_reset"
      unset token; return 1 ;;
    sk-ant-*) ;;
    *)
      printf "  %seso no empieza por 'sk-ant-': no lo instalo.%s %sPega solo el token.%s\n" "$c_err" "$c_reset" "$c_dim" "$c_reset"
      unset token; return 1 ;;
  esac
  printf '%s' "$token" | instala_token_claude "$1" "$2" "$3" "$4"
  local rc=$?
  unset token
  if [ "$rc" != 0 ]; then
    printf "  %sno pude escribir %s/.credentials.json%s %s(rc=%s)%s\n" "$c_err" "$4" "$c_reset" "$c_dim" "$rc" "$c_reset"
    return "$rc"
  fi
  printf "  %stoken instalado en %s/.credentials.json%s %s(modo 600)%s\n" "$c_ok" "$4" "$c_reset" "$c_dim" "$c_reset"
}

# Use device authentication because a browser callback inside the container is not reachable from
# the operator's machine. The device code expires after 15 minutes.
login_codex() {  # $1=alias $2=ctr $3=usu $4=codex-home
  local opcion token
  printf "\n  %s1)%s codigo de dispositivo   %s(por defecto: te da una URL y un codigo de 8 letras)%s\n" "$c_b" "$c_reset" "$c_dim" "$c_reset"
  printf "  %s2)%s pegar un access token   %s(si ya lo tenes a mano)%s\n" "$c_b" "$c_reset" "$c_dim" "$c_reset"
  printf "  %sel flujo de navegador a secas no se ofrece: su callback vive en el localhost del%s\n" "$c_dim" "$c_reset"
  printf "  %scontenedor, no en el tuyo.%s\n" "$c_dim" "$c_reset"
  read -r -p "  opcion [1/2]: " opcion
  if [ "${opcion:-1}" = 2 ]; then
    printf "  Pega el access token y ENTER %s(no se muestra)%s: " "$c_dim" "$c_reset"
    read -r -s token; printf '\n'
    [ -n "$token" ] || { printf "  %stoken vacio: no toco nada%s\n" "$c_warn" "$c_reset"; return 1; }
    # Pass the token through stdin; process arguments are visible in process listings.
    if es_host_native "$1"; then
      printf '%s' "$token" | CODEX_HOME="$4" codex login --with-access-token
    else
      printf '%s' "$token" | docker exec -i --user "$3" -e CODEX_HOME="$4" "$2" codex login --with-access-token
    fi
    unset token
  else
    printf "  %sabri la URL que imprima y escribi el codigo; la sesion se cierra sola al autorizar.%s\n\n" "$c_dim" "$c_reset"
    if es_host_native "$1"; then CODEX_HOME="$4" codex login --device-auth
    else docker exec -it --user "$3" -e CODEX_HOME="$4" "$2" codex login --device-auth; fi
  fi
}

# A Codex account session cannot be shared concurrently by multiple aliases.
choques_de_codex() {  # $1=alias-que-acabo-de-tocar $2=cuenta
  local otro line ctr cuser uhome ch cuenta _r
  [ -n "$2" ] && [ "$2" != '?' ] || return 0
  for otro in $(todos_los_alias); do
    [ "$otro" = "$1" ] && continue
    line=$(alias_info "$otro") || continue
    IFS=$'\t' read -r _ _ ctr cuser uhome _ _ <<<"$line"
    [ -n "$ctr" ] || continue
    ch=$(codex_home_de "$otro" "$uhome")
    IFS='|' read -r _r cuenta _ <<<"$(huella_codex "$otro" "$ctr" "$cuser" "$ch")"
    [ "$cuenta" = "$2" ] && printf "  %schoca con %s%s %s(misma cuenta de codex)%s\n" "$c_err" "$otro" "$c_reset" "$c_dim" "$c_reset"
  done
}

cmd_login() {  # $1=alias  [claude|codex] [--ver] [--forzar]  (en cualquier orden)
  local a=$1 arg='' line ctr cuser uhome harness chome cchome
  line=$(alias_info "$a") || { printf "  %sno conozco el alias %s%s\n" "$c_err" "$a" "$c_reset"; return 2; }
  IFS=$'\t' read -r _ _ ctr cuser uhome _ harness <<<"$line"
  chome=$(codex_home_de "$a" "$uhome")
  cchome=$(claude_home_de "$a" "$uhome" "$harness")

  local solo_ver=0 opt o3; shift
  # Keep --forzar accepted for backward compatibility.
  for opt in "$@"; do case "$opt" in --ver) solo_ver=1 ;; --forzar|-f) : ;; claude|codex) arg=$opt ;; *) printf "  no entiendo '%s'. Usa: cauce %s login [claude|codex] [--ver] [--forzar]\n" "$opt" "$a"; return 2 ;; esac; done

  printf "\n  %s%s%s  %s·  contenedor %s  ·  arnes %s%s\n" \
    "$c_b" "$a" "$c_reset" "$c_dim" "${ctr:-(host-native)}" "$harness" "$c_reset"
  printf "  %s%s%s\n" "$c_dim" "$(printf '─%.0s' $(seq 1 62))" "$c_reset"

  if ! contenedor_alcanzable "$a" "$ctr"; then
    printf "  %sel contenedor %s no aparece en el docker de esta maquina (ni parado)%s\n" "$c_err" "${ctr:-?}" "$c_reset"
    if [ "$(sitio "$a")" = local ]; then
      printf "  %sy esta ES la maquina donde deberia vivir: no esta creado todavia.%s\n" "$c_warn" "$c_reset"
      printf "  %s%s no esta provisionada: crear el contenedor es paso PREVIO al login.%s\n" "$c_dim" "$a" "$c_reset"
    else
      printf "  %sesto NO quiere decir que la credencial este vacia: quiere decir que no la puedo leer.%s\n" "$c_warn" "$c_reset"
      printf "  %sel docker de aqui no es el de la flota. Corre esto donde vivan los contenedores.%s\n" "$c_dim" "$c_reset"
    fi
    return 3
  fi

  # Offer only declared providers whose CLI is installed in the reachable runtime.
  local -a declarados=() objetivos=() faltan=()
  if [ -n "$arg" ]; then declarados=("$arg")
  else mapfile -t declarados < <(objetivos_declarados "$harness" "$a" "$ctr" "$cuser" "$cchome" "$chome"); fi

  local o
  for o in "${declarados[@]}"; do
    if binario_en_alias "$a" "$ctr" "$cuser" "$o"; then objetivos+=("$o"); else faltan+=("$o"); fi
  done

  for o in "${objetivos[@]}"; do
    [ "$o" = claude ] && pinta_credencial claude "$a" "$ctr" "$cuser" "$cchome"
    [ "$o" = codex ]  && pinta_credencial codex  "$a" "$ctr" "$cuser" "$chome"
  done
  # Explain unsupported providers without exposing raw runtime errors.
  for o in "${faltan[@]}"; do
    case "$o" in
      claude) printf "  Claude : %s%-14s%s %sno hay binario 'claude' en %s%s\n" "$c_warn" "NO INSTALADO" "$c_reset" "$c_dim" "${ctr:-(host-native)}" "$c_reset";;
      codex)  printf "  Codex  : %s%-14s%s %sno hay binario 'codex' en %s%s\n" "$c_warn" "NO INSTALADO" "$c_reset" "$c_dim" "${ctr:-(host-native)}" "$c_reset";;
    esac
  done

  if [ ${#objetivos[@]} -eq 0 ]; then
    if [ ${#faltan[@]} -gt 0 ]; then
      printf "\n  %s%s no tiene instalado ese arnes: no hay nada que renovar por aqui.%s\n" "$c_err" "$a" "$c_reset"
      printf "  %sel binario no viene en la imagen, se instala por alias. Tenerlo es paso PREVIO%s\n" "$c_dim" "$c_reset"
      printf "  %sal login: sin binario no hay comando de login que ejecutar dentro del contenedor.%s\n" "$c_dim" "$c_reset"
      return 4
    fi
    printf "  %sno encuentro ninguna credencial que renovar en este alias%s\n" "$c_warn" "$c_reset"
    return 1
  fi
  [ "$solo_ver" = 1 ] && return 0

  if turno_en_vuelo "$a"; then
    printf "\n  %s%s TIENE UN TURNO EN VUELO ahora mismo%s — si seguis, ese turno muere; la entrega vuelve a la cola o se repone por consola.\n" "$c_err" "$a" "$c_reset"
    for o3 in "${objetivos[@]}"; do [ "$o3" = claude ] && [[ $(huella_claude "$a" "$ctr" "$cuser" "$cchome") == VACIA* ]] && printf "  %scon la credencial de claude VACIA ese turno ya no puede autenticar: no hay nada que salvar.%s\n" "$c_warn" "$c_reset"; done
    printf "  %sel login tiene prioridad: sigo.%s\n" "$c_warn" "$c_reset"
  fi

  # Warn before confirmation because authentication stops the alias and can take up to 15 minutes.
  local tiene_codex=0 o2
  for o2 in "${objetivos[@]}"; do [ "$o2" = codex ] && tiene_codex=1; done
  printf "\n  %sAVISO — a partir de que confirmes, %s queda APAGADO hasta terminar el login.%s\n" "$c_warn" "$a" "$c_reset"
  printf "  %sLo que le escriban mientras tanto no se pierde: se encola y lo atiende al volver.%s\n" "$c_warn" "$c_reset"
  if [ "$tiene_codex" = 1 ]; then
    printf "  %sSi renovas codex por codigo de dispositivo, eso puede ser hasta 15 MINUTOS%s\n" "$c_warn" "$c_reset"
    printf "  %s(es lo que tarda en caducar el codigo). Tene el navegador abierto ANTES de seguir.%s\n" "$c_warn" "$c_reset"
  fi
  printf "  %smientras este apagado el guardia lo va a reportar caido: es esperado, no es un fallo.%s\n" "$c_dim" "$c_reset"

  local que=${objetivos[0]}
  if [ ${#objetivos[@]} -gt 1 ]; then
    printf "\n  este alias usa los dos. %sc%s) claude   %sx%s) codex   %sn%s) nada\n" "$c_b" "$c_reset" "$c_b" "$c_reset" "$c_b" "$c_reset"
    local q; read -r -p "  opcion [c/x/n]: " q
    case "$q" in c|C) que=claude ;; x|X) que=codex ;; *) printf "  no toco nada.\n"; return 0 ;; esac
  else
    local q; read -r -p "  renovar la credencial de ${que}? [s/N]: " q
    [[ $q == [sS] ]] || { printf "  no toco nada.\n"; return 0; }
  fi

  # Capture the credential fingerprint before login to verify the effect.
  local antes despues tipo cuenta correo
  if [ "$que" = claude ]; then antes=$(huella_claude "$a" "$ctr" "$cuser" "$cchome")
  else antes=$(huella_codex "$a" "$ctr" "$cuser" "$chome"); fi

  printf "\n  %s-- apagando el adaptador de %s --%s\n" "$c_dim" "$a" "$c_reset"
  # Continue credential renewal if process cleanup fails; otherwise the alias remains off without a replacement.
  cmd_off "$a" || printf "  %sno quedo apagado del todo; el login tiene prioridad: sigo igual%s\n" "$c_warn" "$c_reset"

  if [ "$que" = claude ]; then login_claude "$a" "$ctr" "$cuser" "$cchome"
  else login_codex "$a" "$ctr" "$cuser" "$chome"; fi

  printf "\n  %s-- como quedo --%s\n" "$c_dim" "$c_reset"
  if [ "$que" = claude ]; then
    despues=$(huella_claude "$a" "$ctr" "$cuser" "$cchome")
    pinta_credencial claude "$a" "$ctr" "$cuser" "$cchome"
    # Check authentication through Claude; file existence alone does not prove a valid login.
    printf "  %sclaude dice:%s %s\n" "$c_dim" "$c_reset" "$(estado_auth_claude "$a" "$ctr" "$cuser" "$cchome" | head -1)"
  else
    despues=$(huella_codex "$a" "$ctr" "$cuser" "$chome")
    pinta_credencial codex "$a" "$ctr" "$cuser" "$chome"
    IFS='|' read -r tipo cuenta correo <<<"$despues"
    choques_de_codex "$a" "$cuenta"
  fi
  # A zero exit status does not prove the credential changed; verify the effect.
  if [ "$antes" = "$despues" ]; then
    printf "  %sla credencial NO cambio%s — quedo la misma de antes. El login no prendio.\n" "$c_err" "$c_reset"
  else
    printf "  %scredencial nueva escrita%s\n" "$c_ok" "$c_reset"
  fi

  printf "\n  %s-- levantando el adaptador de %s --%s\n" "$c_dim" "$a" "$c_reset"
  cmd_on "$a"
}

# Provision steps are ordered; stop on the first failure to avoid a partial identity.
FLOTA_JSON=$OPS/flota.json
PKI_ROOT_AGENTE=/etc/cauce-v3/pki
TOKENS_DIR_ALIAS=/etc/cauce-v3/aliases
IDENTIDADES_DIR=/etc/cauce-v3/secrets/identities
TELEGRAM_RUNTIME_DIR=${CAUCE_TELEGRAM_RUNTIME_DIR:-/etc/cauce-v3/telegram-runtime}
TELEGRAM_OWNER=${CAUCE_TELEGRAM_OWNER:-1000:1000}

# Expose owner, mode and size only; never display credential contents.
estampa_modo() {  # $1=path
  if [ -e "$1" ]; then
    stat -c 'owner=%U:%G modo=%a bytes=%s' "$1" 2>/dev/null || printf 'sin stat'
  else
    printf 'no existe'
  fi
}

# Keep the default PKI path aligned with the PTY launcher and unit.
pty_pki_root() {
  printf '%s\n' "${CAUCE_PTY_PKI_ROOT:-${XDG_CONFIG_HOME:-$HOME/.config}/cauce-v3/pty-pki}"
}

# ops/flota.json is authoritative; stdout and exit statuses form this helper's caller contract.
flota_estado_alias() {  # $1=alias
  [ -f "$FLOTA_JSON" ] || return 3
  python3 -c '
import json, sys
alias = sys.argv[2]
try:
    doc = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(3)
fleet = doc.get("fleet") or {}
retired = doc.get("retired") or {}
if alias in fleet and fleet[alias].get("enabled") is True:
    row = fleet[alias]
    print("%s\t%s" % (row.get("tenant", ""), row.get("role", "")))
    sys.exit(0)
if alias in fleet:
    sys.exit(2)
if alias in retired:
    sys.exit(4)
sys.exit(1)
' "$FLOTA_JSON" "$1"
}

cmd_aprovisionar() {  # $1=alias [--dry-run]
  local a=$1 dry=0
  shift || true
  case "${1:-}" in
    --dry-run) dry=1 ;;
    "") ;;
    *) printf "  no entiendo '%s'\n" "$1"; return 2 ;;
  esac

  printf "\n  %saprovisionar %s%s" "$c_b" "$a" "$c_reset"
  [ "$dry" = 1 ] && printf "  %s(--dry-run: nada se escribe)%s" "$c_dim" "$c_reset"
  printf "\n\n"

  # Require the fleet snapshot and signing CA before issuing credentials.
  local ap_tenant ap_role salida rc
  salida=$(flota_estado_alias "$a"); rc=$?
  case $rc in
    0) IFS=$'\t' read -r ap_tenant ap_role <<<"$salida"
       printf "  [0] %s: ops/flota.json lo tiene enabled=true (tenant=%s rol=%s)\n" "$a" "$ap_tenant" "$ap_role" ;;
    1) printf "  [0] %s%s no esta en ops/flota.json (ni fleet ni retired)%s\n" "$c_err" "$a" "$c_reset"
       printf "      alta = 1 INSERT en agents+memberships, luego export-fleet-snapshot.py --out ops/flota.json\n"
       return 1 ;;
    2) printf "  [0] %s%s esta en ops/flota.json con enabled=false%s\n" "$c_err" "$a" "$c_reset"
       return 1 ;;
    4) printf "  [0] %s%s esta RETIRADO en ops/flota.json%s\n" "$c_err" "$a" "$c_reset"
       return 1 ;;
    *) printf "  [0] %sno pude leer %s%s\n" "$c_err" "$FLOTA_JSON" "$c_reset"
       return 1 ;;
  esac
  local ca_cert=${CAUCE_CLIENT_CA_CERT:-$PKI_ROOT_AGENTE/ca.crt}
  local ca_key=${CAUCE_CLIENT_CA_KEY:-$PKI_ROOT_AGENTE/ca.key}
  local ca_ok=1 f
  for f in "$ca_cert" "$ca_key"; do
    if [ -f "$f" ]; then
      printf "      ok %s (%s)\n" "$f" "$(estampa_modo "$f")"
    else
      printf "  [0] %sfalta %s%s\n" "$c_err" "$f" "$c_reset"
      ca_ok=0
    fi
  done
  if [ "$ca_ok" != 1 ]; then
    printf "      la CA no esta en esta maquina: pedila al dueno, o exporta CAUCE_CLIENT_CA_CERT/CAUCE_CLIENT_CA_KEY\n"
    printf "      si vive en otra ruta (docs/operacion.md (alta y baja), pieza 0)\n"
    return 1
  fi

  # Refuse to overwrite an existing mTLS identity.
  local id_cert="$PKI_ROOT_AGENTE/agent-$a.crt" id_key="$PKI_ROOT_AGENTE/agent-$a.key"
  if [ -e "$id_cert" ] || [ -e "$id_key" ]; then
    printf "  [1] agent-%s ya tiene identidad (se salta):\n" "$a"
    printf "      %s -> %s\n" "$id_cert" "$(estampa_modo "$id_cert")"
    printf "      %s -> %s\n" "$id_key" "$(estampa_modo "$id_key")"
  elif [ "$dry" = 1 ]; then
    printf "  [1] haria: provision-agent-identity.sh %s %s\n" "$a" "$PKI_ROOT_AGENTE"
  else
    if "$OPS/scripts/provision-agent-identity.sh" "$a" "$PKI_ROOT_AGENTE"; then
      printf "  [1] identidad emitida:\n"
      printf "      %s -> %s\n" "$id_cert" "$(estampa_modo "$id_cert")"
      printf "      %s -> %s\n" "$id_key" "$(estampa_modo "$id_key")"
    else
      printf "  [1] %sprovision-agent-identity.sh fallo%s\n" "$c_err" "$c_reset"
      return 1
    fi
  fi

  # Register the fingerprint of the certificate issued in step 1.
  local register_script="$OPS/scripts/register-agent-identity.py"
  if [ ! -f "$register_script" ]; then
    printf "  [1b] %sno encuentro %s%s\n" "$c_err" "$register_script" "$c_reset"
    [ "$dry" = 1 ] || return 1
  else
    local -a register_args=(--alias "$a" --cert-dir "$PKI_ROOT_AGENTE" --identities-dir "$IDENTIDADES_DIR")
    [ "$dry" = 1 ] && register_args+=(--dry-run)
    local salida1b
    if salida1b=$(python3 "$register_script" "${register_args[@]}" 2>&1); then
      printf "  [1b] %s\n" "$salida1b"
      [ "$dry" = 1 ] || printf "      %s -> %s\n" "$IDENTIDADES_DIR/mtls_identities.json" "$(estampa_modo "$IDENTIDADES_DIR/mtls_identities.json")"
    else
      printf "  [1b] %s%s%s\n" "$c_err" "$salida1b" "$c_reset"
      return 1
    fi
  fi

  # Issue the bearer token and record its hash.
  local issue_script="$OPS/scripts/issue-alias-token.py"
  if [ ! -f "$issue_script" ]; then
    printf "  [2] %sno encuentro %s%s (docs/operacion.md (alta y baja), pieza 2)\n" "$c_err" "$issue_script" "$c_reset"
    [ "$dry" = 1 ] || return 1
  else
    local -a issue_args=(--alias "$a" --tokens-dir "$TOKENS_DIR_ALIAS" --identities-dir "$IDENTIDADES_DIR")
    [ "$dry" = 1 ] && issue_args+=(--dry-run)
    local salida2
    if salida2=$(python3 "$issue_script" "${issue_args[@]}" 2>&1); then
      printf "  [2] %s\n" "$salida2"
      if [ "$dry" != 1 ]; then
        printf "      %s -> %s\n" "$TOKENS_DIR_ALIAS/$a.token" "$(estampa_modo "$TOKENS_DIR_ALIAS/$a.token")"
        printf "      %s -> %s\n" "$IDENTIDADES_DIR/token_hashes.json" "$(estampa_modo "$IDENTIDADES_DIR/token_hashes.json")"
      fi
    else
      printf "  [2] %s%s%s\n" "$c_err" "$salida2" "$c_reset"
      return 1
    fi
  fi

  # The alias key belongs to the PTY channel; preview its write because the publisher has no dry-run flag.
  local pty_dir pty_key
  pty_dir="$(pty_pki_root)/$a"
  pty_key="$pty_dir/alias-key.hex"
  if [ -e "$pty_key" ]; then
    printf "  [3] %s ya existe (se salta): %s\n" "$pty_key" "$(estampa_modo "$pty_key")"
  elif [ "$dry" = 1 ]; then
    printf "  [3] haria: publish-alias-key.sh --tenant %s --alias %s --output-dir %s\n" "$ap_tenant" "$a" "$pty_dir"
  else
    # Only apply the conventional default when the operator picked none of the three env
    # forms publish-alias-key.sh itself understands — never override an explicit choice.
    if [ -z "${CAUCE_PTY_MASTER_FILE:-}${CAUCE_PTY_MASTER_ENV:-}${CAUCE_PTY_MASTER:-}" ]; then
      CAUCE_PTY_MASTER_FILE=/etc/cauce-v3/secrets/pty_master.key
    fi
    if [ -n "${CAUCE_PTY_MASTER_FILE:-}" ] && [ ! -f "$CAUCE_PTY_MASTER_FILE" ] \
       && [ -z "${CAUCE_PTY_MASTER_ENV:-}${CAUCE_PTY_MASTER:-}" ]; then
      printf "  [3] %sno hay master PTY: falta %s%s\n" "$c_err" "$CAUCE_PTY_MASTER_FILE" "$c_reset"
      printf "      (o exporta CAUCE_PTY_MASTER_ENV=VAR / CAUCE_PTY_MASTER=valor antes de aprovisionar)\n"
      return 1
    fi
    [ -n "${CAUCE_PTY_MASTER_FILE:-}" ] && export CAUCE_PTY_MASTER_FILE
    if "$OPS/pty-agent/publish-alias-key.sh" --tenant "$ap_tenant" --alias "$a" --output-dir "$pty_dir"; then
      printf "  [3] %s -> %s\n" "$pty_key" "$(estampa_modo "$pty_key")"
    else
      printf "  [3] %spublish-alias-key.sh fallo%s\n" "$c_err" "$c_reset"
      return 1
    fi
  fi

  # Sign the PTY client certificate with the same client CA as step 1.
  local pty_crt="$pty_dir/client.crt" pty_ckey="$pty_dir/client.key" fp_pty="" vence_pty=""
  if [ -e "$pty_crt" ] && openssl x509 -in "$pty_crt" -noout -checkend 0 >/dev/null 2>&1; then
    printf "  [3b] %s ya existe y no esta vencido (se salta): %s\n" "$pty_crt" "$(estampa_modo "$pty_crt")"
  elif [ "$dry" = 1 ]; then
    printf "  [3b] haria: emitir clave RSA 4096 + cert CN=pty-%s (365 dias, firmado por %s) en %s\n" "$a" "$ca_cert" "$pty_dir"
  else
    if ( set -e; umask 077
         install -d -m 0700 -- "$pty_dir"
         openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$pty_ckey.tmp" 2>/dev/null
         openssl req -new -sha256 -key "$pty_ckey.tmp" -subj "/CN=pty-$a" -out "$pty_dir/.pty.csr"
         printf '%s\n' 'extendedKeyUsage=clientAuth' 'basicConstraints=critical,CA:FALSE' \
           'keyUsage=critical,digitalSignature,keyEncipherment' >"$pty_dir/.pty.ext"
         openssl x509 -req -sha256 -in "$pty_dir/.pty.csr" -CA "$ca_cert" -CAkey "$ca_key" \
           -CAserial "${ca_cert%.*}.srl" -CAcreateserial -days 365 \
           -extfile "$pty_dir/.pty.ext" -out "$pty_crt.tmp" 2>/dev/null
         openssl verify -purpose sslclient -CAfile "$ca_cert" "$pty_crt.tmp" >/dev/null
         cp -- "$ca_cert" "$pty_dir/.ca.tmp"
         chmod 600 -- "$pty_ckey.tmp" "$pty_crt.tmp" "$pty_dir/.ca.tmp"
         mv -- "$pty_ckey.tmp" "$pty_ckey"; mv -- "$pty_crt.tmp" "$pty_crt"; mv -- "$pty_dir/.ca.tmp" "$pty_dir/ca.crt"
         rm -f -- "$pty_dir/.pty.csr" "$pty_dir/.pty.ext" ); then
      printf "  [3b] cert PTY emitido: %s -> %s\n" "$pty_crt" "$(estampa_modo "$pty_crt")"
    else
      rm -f -- "$pty_ckey.tmp" "$pty_crt.tmp" "$pty_dir/.pty.csr" "$pty_dir/.pty.ext" "$pty_dir/.ca.tmp"
      printf "  [3b] %sno pude emitir el cert PTY de %s%s\n" "$c_err" "$a" "$c_reset"
      return 1
    fi
  fi

  # The relay reads this allowlist on each new connection.
  local reg=${CAUCE_PTY_RELAY_IDENTITIES:-/etc/cauce-v3/terminal/pty_agent_identities.json}
  if [ -e "$pty_crt" ]; then
    fp_pty=$(openssl x509 -in "$pty_crt" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 | tr -d :)
    vence_pty=$(date -u -d "$(openssl x509 -in "$pty_crt" -noout -enddate | cut -d= -f2)" +%Y-%m-%dT%H:%M:%SZ)
  fi
  if [ -n "$fp_pty" ] && grep -q "\"$fp_pty\"" "$reg" 2>/dev/null; then
    printf "  [3c] la huella de pty-%s ya esta en %s (se salta)\n" "$a" "$reg"
  elif [ "$dry" = 1 ]; then
    printf "  [3c] haria: anexar {tenant_id=%s, alias=%s, huella, expires_at} en %s\n" "$ap_tenant" "$a" "$reg"
  elif REG="$reg" TEN="$ap_tenant" AL="$a" FP="$fp_pty" EXP="$vence_pty" python3 - <<'PY'
import fcntl, json, os, shutil
reg = os.environ["REG"]
lock = open(reg + ".lock", "a+"); fcntl.flock(lock, fcntl.LOCK_EX)
doc = json.load(open(reg)) if os.path.exists(reg) else {"version": 1, "agents": []}
row = {"tenant_id": os.environ["TEN"], "alias": os.environ["AL"],
       "fingerprint_sha256": os.environ["FP"], "expires_at": os.environ["EXP"]}
if any(x.get("alias") == row["alias"] and x.get("fingerprint_sha256") == row["fingerprint_sha256"] for x in doc.get("agents", [])): raise SystemExit(0)
doc.setdefault("agents", []).append(row); tmp = reg + ".tmp"
if os.path.exists(reg): shutil.copy2(reg, reg + ".bak")
with open(tmp, "w") as out:
    json.dump(doc, out, indent=2); out.write("\n"); out.flush(); os.fsync(out.fileno())
if os.path.exists(reg):
    st = os.stat(reg); os.chmod(tmp, st.st_mode & 0o777); os.chown(tmp, st.st_uid, st.st_gid)
else:
    os.chmod(tmp, 0o440)
os.replace(tmp, reg)
PY
  then
    printf "  [3c] huella de pty-%s anexada en %s (vence %s)\n" "$a" "$reg" "$vence_pty"
  else
    printf "  [3c] %sno pude registrar la huella en %s%s\n" "$c_err" "$reg" "$c_reset"
    return 1
  fi

  # Keep the launcher environment aligned with pty_pki_root().
  local pty_env="${XDG_CONFIG_HOME:-$HOME/.config}/cauce-v3/pty/$a.env"
  if [ -e "$pty_env" ]; then
    printf "  [3d] %s ya existe (se salta): %s\n" "$pty_env" "$(estampa_modo "$pty_env")"
  elif [ "$dry" = 1 ]; then
    printf "  [3d] haria: escribir %s (RELAY_HOST/RELAY_PORT/PKI_DIR/ALIAS_KEY_FILE, modo 600)\n" "$pty_env"
  else
    install -d -m 0700 -- "${pty_env%/*}"
    if ( umask 177; printf 'RELAY_HOST=100.64.0.6\nRELAY_PORT=8445\nPKI_DIR=%s\nALIAS_KEY_FILE=%s\n' \
         "$pty_dir" "$pty_key" >"$pty_env.tmp" ) && mv -- "$pty_env.tmp" "$pty_env"; then
      printf "  [3d] %s -> %s\n" "$pty_env" "$(estampa_modo "$pty_env")"
    else
      rm -f -- "$pty_env.tmp"
      printf "  [3d] %sno pude escribir %s%s\n" "$c_err" "$pty_env" "$c_reset"
      return 1
    fi
  fi

  # Skip existing identity material; update-alias-config.py --init refuses to overwrite it.
  local cp_dir="/etc/cauce-v3/container-pki/$a" cp_env="/etc/cauce-v3/container-aliases/$a.env"
  if [ -e "$cp_dir/ca.crt" ] && [ -e "$cp_dir/client.crt" ] && [ -e "$cp_dir/client.key" ] && [ -e "$cp_env" ]; then
    printf "  [4] container-pki/%s/ y %s.env ya estan inicializados (se salta):\n" "$a" "$a"
    printf "      %s -> %s\n" "$cp_dir" "$(estampa_modo "$cp_dir")"
    printf "      %s -> %s\n" "$cp_env" "$(estampa_modo "$cp_env")"
  elif [ "$dry" = 1 ]; then
    printf "  [4] haria: update-alias-config.py init --alias %s\n" "$a"
  elif python3 "$OPS/scripts/update-alias-config.py" init --alias "$a"; then
    printf "  [4] container-pki/%s/ y %s.env inicializados:\n" "$a" "$a"
    printf "      %s -> %s\n" "$cp_dir" "$(estampa_modo "$cp_dir")"
    printf "      %s -> %s\n" "$cp_env" "$(estampa_modo "$cp_env")"
  else
    printf "  [4] %supdate-alias-config.py init fallo%s\n" "$c_err" "$c_reset"
    return 1
  fi

  # Publish config only after the referenced token exists; update only this alias entry.
  local tg_pub="$OPS/scripts/publish-telegram-token.py"
  local -a tg_args=(--runtime-dir "$TELEGRAM_RUNTIME_DIR" --alias "$a" --reuse-existing-allowlist
                    --owner "$TELEGRAM_OWNER")
  [ "$dry" = 1 ] && tg_args+=(--dry-run)
  local tg_salida
  if [ ! -f "$tg_pub" ]; then
    printf "  [5] %sno encuentro %s%s\n" "$c_err" "$tg_pub" "$c_reset"
    [ "$dry" = 1 ] || return 1
  else
    [ "$dry" = 1 ] || printf "      el token de BotFather es la unica pieza que no se puede generar (se pide si falta).\n"
    if tg_salida=$(python3 "$tg_pub" "${tg_args[@]}"); then
      printf "  [5] %s\n" "${tg_salida//$'\n'/$'\n'      }"
    else
      printf "  [5] %spublish-telegram-token.py fallo: config.json queda como estaba%s\n" "$c_err" "$c_reset"
      [ "$dry" = 1 ] || return 1
    fi
  fi

  # Verify the result without mutating the alias.
  printf "\n  [6] verificacion (equivalente a 'cauce %s ver'):\n" "$a"
  local linea; linea=$(alias_info "$a")
  if [ -n "$linea" ]; then
    local ctr cuser harness
    IFS=$'\t' read -r _ _ ctr cuser _ _ harness _ <<<"$linea"
    printf "      contenedor=%s usuario=%s arnes=%s adaptador=%s\n" "$ctr" "$cuser" "$harness" "$(adaptador_activo "$a")"
  else
    printf "      %s%s todavia no aparece en container-alias-query.py%s %s(falta regenerate-fleet.sh?)%s\n" "$c_warn" "$a" "$c_reset" "$c_dim" "$c_reset"
  fi
  printf "\n  %saprovisionar %s: terminado%s" "$c_ok" "$a" "$c_reset"
  [ "$dry" = 1 ] && printf " %s(dry-run, nada se escribio)%s" "$c_dim" "$c_reset"
  printf "\n\n"
}
