#!/usr/bin/env bash
# Smoke post-deploy de Cauce V3: verifica EFECTOS reales, no botones verdes.
# Sale 0 solo si todo pasa. Se puede correr suelto en cualquier momento.
set -euo pipefail
GW="${CAUCE_GATEWAY_URL:-https://100.64.0.11:8443}"
PG=(docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce -tA -c)
fallo=0
chk() { local nombre="$1"; shift; if "$@" >/dev/null 2>&1; then echo "OK  $nombre"; else echo "ROJO $nombre"; fallo=1; fi; }

chk "gateway /health/ready"  curl -fsk --max-time 10 "$GW/health/ready"
chk "gateway /v3/status"     curl -fsk --max-time 10 "$GW/v3/status"

ver="$("${PG[@]}" "SELECT max(version) FROM schema_migrations")"
if [ "${ver:0:3}" = "037" ]; then echo "OK  esquema $ver"; else echo "ROJO esquema en '$ver' (esperaba 037_*)"; fallo=1; fi

vivos="$("${PG[@]}" "SELECT count(*) FROM connection_leases WHERE last_heartbeat_at > now() - interval '60 seconds'")"
if [ "${vivos:-0}" -ge 8 ]; then echo "OK  flota: $vivos arriendos frescos"; else echo "ROJO flota: solo ${vivos:-0} arriendos frescos"; fallo=1; fi

done1h="$("${PG[@]}" "SELECT count(*) FROM deliveries WHERE status='done' AND updated_at > now() - interval '1 hour'")"
if [ "${done1h:-0}" -ge 1 ]; then echo "OK  bus: $done1h entregas done en 1h"; else echo "ROJO bus: 0 entregas done en 1h"; fallo=1; fi

conn="$(docker logs cauce-v3-prod-terminal-relay-1 --since 2m 2>/dev/null | grep -c 'terminal_relay_agent_connected"' || true)"
if [ "${conn:-0}" -lt 30 ]; then echo "OK  relay: $conn conexiones/2min (sin bucle)"; else echo "ROJO relay: $conn conexiones/2min (supersede loop: plan-reestructura/fase3/pty-huerfanos.md)"; fallo=1; fi

code="$(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' "$GW/v3/console/agents/zeus/documents")"
if [ "$code" != "404" ]; then echo "OK  ruta documents responde $code (existe)"; else echo "ROJO ruta documents: 404 (el editor sigue sin desplegar)"; fallo=1; fi

echo
echo "== MANUAL (el dueño): editar un fichero de gobierno desde la consola y verificarlo DENTRO del"
echo "   contenedor (docker exec <c> cat <ruta>); abrir una TUI y verla viva >60s."
exit $fallo
