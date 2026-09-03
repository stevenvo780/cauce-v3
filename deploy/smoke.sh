#!/usr/bin/env bash
# Exits 0 only if all pass. Can be run standalone anytime.
set -uo pipefail
CONSOLE="${CAUCE_CONSOLE_URL:-https://100.64.0.11:8444}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PG=(docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce -tA -c)
fallo=0

# 1) Gateway health on internal port (8081), using the image's official probe
if docker exec cauce-v3-prod-gateway-1 node /app/deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready >/dev/null 2>&1; then
  echo "OK  gateway /health/ready (probe interno)"
else echo "ROJO gateway /health/ready"; fallo=1; fi

# 2) Containers healthy per Docker
for c in gateway dispatcher terminal-relay telegram-bridge console; do
  st="$(docker inspect --format '{{.State.Health.Status}}' "cauce-v3-prod-$c-1" 2>/dev/null || echo ausente)"
  if [ "$st" = "healthy" ]; then echo "OK  $c healthy"; else echo "ROJO $c: $st"; fallo=1; fi
done

#
# Ahora la expectativa se lee del directorio de migraciones: no puede quedarse atras.
ESPERADA="$(find "$REPO_DIR/packages/store/migrations" -maxdepth 1 -type f -name '[0-9]*.sql' -printf '%f\n' | sort | tail -1)"
ver="$("${PG[@]}" "SELECT max(version) FROM schema_migrations" 2>/dev/null)"
if [ -z "$ESPERADA" ]; then
  echo "ROJO esquema: no pude leer las migraciones del repo para saber que esperar"; fallo=1
elif [ "$ver" = "$ESPERADA" ]; then echo "OK  esquema $ver"
else echo "ROJO esquema en '$ver' (el repo declara '$ESPERADA')"; fallo=1; fi

# 4) Fleet alive: >=8 leases with fresh heartbeat (<60s)
# The fleet reconnects after `up`, so give it up to 2 minutes before calling it red.
vivos=0
for intento in 1 2 3 4 5 6; do
  vivos="$("${PG[@]}" "SELECT count(*) FROM connection_leases WHERE last_heartbeat_at > now() - interval '60 seconds'" 2>/dev/null)"
  [ "${vivos:-0}" -ge 8 ] && break
  [ "$intento" -lt 6 ] && sleep 20
done
if [ "${vivos:-0}" -ge 8 ]; then echo "OK  flota: $vivos arriendos frescos"; else echo "ROJO flota: solo ${vivos:-0} arriendos frescos"; fallo=1; fi

# 5) Bus moves messages after THIS deployment booted: baseline = gateway start, capped at 6h back because nights are legitimately quiet
arranque="$(docker inspect --format '{{.State.StartedAt}}' cauce-v3-prod-gateway-1 2>/dev/null || echo '')"
if [[ ! "$arranque" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then
  echo "ROJO bus: no pude leer el instante de arranque del gateway (linea base)"; fallo=1
else
  hechas=0; vivas=0
  for intento in 1 2 3 4 5 6; do
    hechas="$("${PG[@]}" "SELECT count(*) FROM deliveries WHERE status='done' AND updated_at > GREATEST('$arranque'::timestamptz, now() - interval '6 hours')" 2>/dev/null)"
    [ "${hechas:-0}" -ge 1 ] && break
    [ "$intento" -lt 6 ] && sleep 20
  done
  # A quiet window is not a broken bus: work claimed or heartbeated since boot proves it moves.
  vivas="$("${PG[@]}" "SELECT count(*) FROM deliveries WHERE terminal_at IS NULL AND status IN ('leased','accepted','started') AND updated_at > '$arranque'::timestamptz" 2>/dev/null)"
  if [ "${hechas:-0}" -ge 1 ]; then echo "OK  bus: $hechas entregas done desde el arranque ($arranque)";
  elif [ "${vivas:-0}" -ge 1 ]; then echo "OK  bus: sin entregas done en la ventana, pero $vivas en vuelo con actividad desde el arranque ($arranque)";
  else echo "ROJO bus: ni entregas done ni actividad en vuelo desde el arranque del despliegue ($arranque)"; fallo=1; fi
fi

# 6) Relay NOT in a loop: <30 agent connections in 2 min
conn="$(docker logs cauce-v3-prod-terminal-relay-1 --since 2m 2>/dev/null | grep -c 'terminal_relay_agent_connected"')"
if [ "${conn:-0}" -lt 30 ]; then echo "OK  relay: $conn conexiones/2min (sin bucle)"; else echo "ROJO relay: $conn conexiones/2min (supersede loop: docs/operacion.md, plano PTY)"; fallo=1; fi

# 7) Governance routes deployed via console nginx (401/403 = exists; 404 = NOT deployed)
code="$(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' "$CONSOLE/v3/console/agents/zeus/documents" || echo 000)"
if [ "$code" != "404" ] && [ "$code" != "000" ]; then echo "OK  ruta documents responde $code (existe)"; else echo "ROJO ruta documents: $code (404=sin desplegar, 000=consola inalcanzable)"; fallo=1; fi

echo
echo "== MANUAL (el dueño): editar un fichero de gobierno desde la consola y verificarlo DENTRO del"
echo "   contenedor (docker exec <c> cat <ruta>); abrir una TUI y verla viva >60s."
exit $fallo
