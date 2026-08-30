#!/usr/bin/env bash
# Vigila cada 24 h las URLs del catalogo Mouseion y avisa al dueno cuando alguna deja de dar 200.
#
# Un agente no puede "vigilar" (Cauce es por eventos); un temporizador si.
#
#   --dry-run   valida destino y permiso contra el gateway SIN escribirle a nadie
#   --list      imprime lo que vigilaria y sale
#
# Sale 1 si hay alguna caida (para que systemd la marque), 0 si todas responden.
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LISTA="${CATALOGO_URLS:-$AQUI/catalogo-mouseion-urls.txt}"
ALIAS="${CAUCE_ALIAS_AVISO:-zeus}"
DESTINO="${CAUCE_DESTINO_AVISO:-steven_dm}"
GATEWAY="${CAUCE_GATEWAY_URL:-https://100.64.0.6:8443}"
PKI="${CAUCE_PKI:-/home/stev/.config/cauce-v3/container-pki}"
INFORME="${CATALOGO_INFORME:-/var/log/cauce-catalogo-health.log}"
ESTADO="${CATALOGO_ESTADO:-${INFORME%.log}.avisadas}"
SALA_AVISO="${CAUCE_SALA_AVISO:-grp.steven}"
TENANT_AVISO="${CAUCE_TENANT_AVISO:-Steven}"
ESPERA="${CATALOGO_TIMEOUT:-20}"

PRUEBA=0
case "${1:-}" in
  --dry-run) PRUEBA=1 ;;
  --list)    grep -vE '^\s*(#|$)' "$LISTA"; exit 0 ;;
  '')        ;;
  *)         echo "uso: $(basename "$0") [--dry-run|--list]" >&2; exit 2 ;;
esac

[ -r "$LISTA" ] || { echo "no puedo leer la lista de URLs: $LISTA" >&2; exit 2; }

SELLO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ROTAS=()
TOTAL=0

while IFS= read -r url; do
  TOTAL=$((TOTAL + 1))
  # -L: cuenta la respuesta FINAL, que es la que ve una persona. 000 (DNS/TLS/timeout) es caida.
  linea="$(curl -sL -o /dev/null --max-time "$ESPERA" \
             -w '%{http_code} %{url_effective}' "$url" 2>/dev/null || echo "000 $url")"
  codigo="${linea%% *}"
  final="${linea#* }"
  printf '%s %s %s -> %s\n' "$SELLO" "$codigo" "$url" "$final" >> "$INFORME" 2>/dev/null || true
  [ "$codigo" = "200" ] || ROTAS+=("$codigo $url")
done < <(grep -vE '^\s*(#|$)' "$LISTA")

echo "catalogo: $((TOTAL - ${#ROTAS[@]}))/$TOTAL en 200"
for r in "${ROTAS[@]:-}"; do [ -n "$r" ] && echo "  ROTA $r"; done

avisar() {
  local cuerpo="$1" clave="$2"
  local cert="$PKI/$ALIAS/client.crt" key="$PKI/$ALIAS/client.key" ca="$PKI/$ALIAS/ca.crt"
  for f in "$cert" "$key" "$ca"; do
    [ -r "$f" ] || { echo "sin certificado mTLS de $ALIAS ($f): no puedo avisar" >&2; return 1; }
  done
  local payload
  payload="$(CUERPO="$cuerpo" DEST="$DESTINO" CLAVE="$clave" PRUEBA="$PRUEBA" python3 -c '
import json, os
print(json.dumps({"destination": os.environ["DEST"], "kind": "alert",
                  "body": os.environ["CUERPO"], "idempotency_key": os.environ["CLAVE"],
                  "dry_run": os.environ["PRUEBA"] == "1"}))')"
  local salida codigo
  salida="$(printf '%s' "$payload" | curl -sS --max-time 25 --cert "$cert" --key "$key" \
              --cacert "$ca" -X POST -H 'content-type: application/json' --data-binary @- \
              -o - -w '\n%{http_code}' "$GATEWAY/v3/egress/notifications" 2>&1)"
  codigo="${salida##*$'\n'}"
  case "$codigo" in
    202) echo "aviso $([ "$PRUEBA" = 1 ] && echo '(dry-run, no se envio nada) ')aceptado para «$DESTINO»" ;;
    403) echo "el gateway RECHAZA el egreso de $ALIAS: ${salida%$'\n'*}" >&2; return 1 ;;
    *)   echo "el gateway respondio $codigo: ${salida%$'\n'*}" >&2; return 1 ;;
  esac
}

# El egreso directo exige el permiso `notify` en el principal mTLS, que hoy el certificado
# `CN=agent-zeus` NO tiene (el gateway responde 403). El bus SI le abre: publicar una entrega para
# un agente si esta permitido. Un guion no puede hablarle a una persona, pero puede despertar a
# quien si puede, y ese agente emite el notify en su turno.
por_el_bus() {
  local texto="$1" clave="$2"
  local cert="$PKI/$ALIAS/client.crt" key="$PKI/$ALIAS/client.key" ca="$PKI/$ALIAS/ca.crt"
  local payload codigo
  payload="$(TEXTO="$texto" CLAVE="$clave" SALA="$SALA_AVISO" TEN="$TENANT_AVISO" AL="$ALIAS" python3 -c '
import json, os
print(json.dumps({"room_id": os.environ["SALA"],
                  "recipients": [{"tenant_id": os.environ["TEN"], "alias": os.environ["AL"]}],
                  "body": {"type": "guardia.alerta", "text": os.environ["TEXTO"]},
                  "idempotency_key": os.environ["CLAVE"]}))')"
  codigo="$(printf '%s' "$payload" | curl -sS --max-time 25 --cert "$cert" --key "$key" \
              --cacert "$ca" -X POST -H 'content-type: application/json' --data-binary @- \
              -o /dev/null -w '%{http_code}' "$GATEWAY/v3/messages" 2>/dev/null)"
  [ "$codigo" = "202" ] && { echo "alerta encolada en el bus para $ALIAS (la lleva al dueno en su turno)"; return 0; }
  echo "tampoco pude encolarla en el bus: el gateway respondio $codigo" >&2
  return 1
}

if [ "$PRUEBA" = 1 ]; then
  avisar "prueba del vigia del catalogo Mouseion: el camino de aviso funciona." \
         "catalogo-health:dry-run:$SELLO" \
    || por_el_bus "prueba del vigia del catalogo Mouseion (ignorar): el respaldo por bus funciona." \
                  "catalogo-health:dry-run-bus:$SELLO" \
    || exit 1
  exit 0
fi

[ ${#ROTAS[@]} -eq 0 ] && exit 0

# Avisa SOLO si hay alguna rota que no estuviera en el aviso anterior: que el conjunto se ENCOJA
# no es noticia, y repetir un subconjunto es ruido con forma de alarma.
NUEVAS="$(printf '%s\n' "${ROTAS[@]}" | sort | comm -23 - <(sort "$ESTADO" 2>/dev/null || true))"
if [ -z "$NUEVAS" ]; then
  echo "sin novedades respecto del aviso anterior: no aviso"
  exit 1
fi

HUELLA="$(printf '%s\n' "${ROTAS[@]}" | sort | sha256sum | cut -c1-12)"
CUERPO="$(printf 'Catalogo Mouseion: %d de %d productos NO responden.\n\n%s\n\nMedido %s. Detalle e historico en %s del VPS.' \
  "${#ROTAS[@]}" "$TOTAL" "$(printf '%s\n' "${ROTAS[@]}" | head -6 | sed 's/^/  /')" "$SELLO" "$INFORME")"
# El estado se apunta SOLO si el aviso salio: apuntarlo antes convierte un aviso fallido en una
# caida muda para siempre, que es justo el fallo que este vigia existe para evitar.
if avisar "$CUERPO" "catalogo-health:$(date -u +%Y-%m-%d):$HUELLA" \
   || por_el_bus "$CUERPO" "catalogo-health-bus:$(date -u +%Y-%m-%d):$HUELLA"; then
  printf '%s\n' "${ROTAS[@]}" | sort > "$ESTADO" \
    || echo "no pude guardar el estado en $ESTADO: la proxima corrida volvera a avisar" >&2
else
  echo "el aviso NO salio por ningun camino: dejo el estado intacto para reintentarlo" >&2
fi
exit 1
