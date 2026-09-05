#!/usr/bin/env bash
# Exits 0 only if all pass. Can be run standalone anytime.
set -uo pipefail
CONSOLE="${CAUCE_CONSOLE_URL:-https://100.64.0.11:8444}"
CONSOLE_CA="${CAUCE_CONSOLE_TLS_CA_PATH:-/etc/cauce-v3/pki/ca.crt}"
FLEET_EXPECTED="${CAUCE_SMOKE_EXPECTED_AGENTS:-15}"
if [[ ! "$FLEET_EXPECTED" =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo "ROJO flota: cardinalidad esperada invalida"; exit 1
fi
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PG=(docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce -tA -c)
fallo=0

# 1) Gateway health on internal port (8081), using the image's official probe
if docker exec cauce-v3-prod-gateway-1 node /app/deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready >/dev/null 2>&1; then
  echo "OK  gateway /health/ready (probe interno)"
else echo "ROJO gateway /health/ready"; fallo=1; fi

# 2) Containers healthy per Docker
for c in gateway dispatcher terminal-relay telegram-bridge console postgres prometheus otel-collector outbox-metrics; do
  st="$(docker inspect --format '{{.State.Health.Status}}' "cauce-v3-prod-$c-1" 2>/dev/null || echo ausente)"
  if [ "$st" = "healthy" ]; then echo "OK  $c healthy"; else echo "ROJO $c: $st"; fallo=1; fi
done

# The repository migration set defines the expected schema.
ESPERADA="$(find "$REPO_DIR/packages/store/migrations" -maxdepth 1 -type f -name '[0-9]*.sql' -printf '%f\n' | sort | tail -1)"
ver="$("${PG[@]}" "SELECT max(version) FROM schema_migrations" 2>/dev/null)"
if [ -z "$ESPERADA" ]; then
  echo "ROJO esquema: no pude leer las migraciones del repo para saber que esperar"; fallo=1
elif [ "$ver" = "$ESPERADA" ]; then echo "OK  esquema $ver"
else echo "ROJO esquema en '$ver' (el repo declara '$ESPERADA')"; fallo=1; fi

# 4) Every enabled registry agent must have an unexpired, fresh lease.
# The fleet reconnects after `up`, so give it up to 2 minutes before calling it red.
vivos=0; esperados=0; flota_valida=0
for intento in 1 2 3 4 5 6; do
  if censo="$("${PG[@]}" "SELECT count(*), count(*) FILTER (WHERE l.lease_until > now() AND l.last_heartbeat_at > now() - interval '60 seconds' AND l.last_heartbeat_at > l.connected_at AND l.capabilities ? 'heartbeat' AND l.instance_id IN ('systemd-'||a.alias,'systemd-container-'||a.alias)) FROM agents a LEFT JOIN connection_leases l ON l.tenant_id = a.tenant_id AND l.alias = a.alias WHERE a.enabled" 2>/dev/null)" \
    && [[ "$censo" =~ ^([0-9]+)\|([0-9]+)$ ]]; then
    esperados=${BASH_REMATCH[1]}; vivos=${BASH_REMATCH[2]}
    if (( esperados == FLEET_EXPECTED && vivos == esperados )); then flota_valida=1; break; fi
  else
    echo "ROJO flota: no pude verificar el censo del registro"; fallo=1; break
  fi
  [ "$intento" -lt 6 ] && sleep 20
done
if [ "$flota_valida" = 1 ]; then echo "OK  flota: $vivos/$esperados agentes habilitados con arriendo vigente y fresco";
else echo "ROJO flota: $vivos/$esperados agentes habilitados con arriendo vigente y fresco (esperados: $FLEET_EXPECTED)"; fallo=1; fi

# 5) Bus moves messages after THIS deployment booted: baseline = gateway start, capped at 6h back because nights are legitimately quiet
arranque="$(docker inspect --format '{{.State.StartedAt}}' cauce-v3-prod-gateway-1 2>/dev/null || echo '')"
if [[ ! "$arranque" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then
  echo "ROJO bus: no pude leer el instante de arranque del gateway (linea base)"; fallo=1
else
  hechas=0; vivas=0
  for intento in 1 2 3 4 5 6; do
    hechas="$("${PG[@]}" "SELECT count(*) FROM deliveries d WHERE d.status='done' AND d.last_ack_rank=3 AND d.terminal_at > GREATEST('$arranque'::timestamptz, now() - interval '6 hours') AND EXISTS (SELECT 1 FROM delivery_acks ack WHERE ack.delivery_id=d.id AND ack.status='done' AND ack.applied AND ack.attempt=d.attempt AND ack.claim_token=d.claim_token AND ack.instance_id=d.consumer_instance_id AND ack.epoch=d.consumer_epoch)" 2>/dev/null)"
    [ "${hechas:-0}" -ge 1 ] && break
    [ "$intento" -lt 6 ] && sleep 20
  done
  vivas="$("${PG[@]}" "SELECT count(*) FROM deliveries d JOIN connection_leases l ON l.tenant_id=d.recipient_tenant AND l.alias=d.recipient_alias AND l.instance_id=d.consumer_instance_id AND l.epoch=d.consumer_epoch WHERE d.terminal_at IS NULL AND d.status='started' AND d.last_ack_rank=2 AND d.execution_started_at IS NOT NULL AND d.ack_deadline_at>now() AND d.claim_expires_at>now() AND l.lease_until>now() AND l.last_heartbeat_at>now()-interval '60 seconds' AND EXISTS (SELECT 1 FROM delivery_acks ack WHERE ack.delivery_id=d.id AND ack.applied AND ack.status='started' AND ack.attempt=d.attempt AND ack.claim_token=d.claim_token AND ack.instance_id=d.consumer_instance_id AND ack.epoch=d.consumer_epoch AND ack.created_at>GREATEST('$arranque'::timestamptz,now()-interval '60 seconds'))" 2>/dev/null)"
  if [[ "$hechas" =~ ^[0-9]+$ ]] && [ "$hechas" -ge 1 ]; then echo "OK  bus: $hechas entregas done con ACK aplicado desde el arranque ($arranque)";
  elif [[ "$vivas" =~ ^[0-9]+$ ]] && [ "$vivas" -ge 1 ]; then echo "OK  bus: $vivas ejecuciones con ACK reciente y arriendo vigente (sin resultado final acreditado)";
  else echo "ROJO bus: ni entregas done ni actividad en vuelo desde el arranque del despliegue ($arranque)"; fallo=1; fi
fi

# 6) Relay NOT in a loop: <30 agent connections in 2 min
if relay_logs="$(docker logs cauce-v3-prod-terminal-relay-1 --since 2m 2>&1)"; then
  conn="$(grep -c '"event"[[:space:]]*:[[:space:]]*"terminal_relay_agent_connected"' <<< "$relay_logs")"
  if [[ ! "$conn" =~ ^[0-9]+$ ]]; then
    echo "ROJO relay: no pude contar los eventos de conexion"; fallo=1
  elif [ "$conn" -lt 30 ]; then
    echo "OK  relay: $conn conexiones/2min (sin bucle)"
  else
    echo "ROJO relay: $conn conexiones/2min (supersede loop: docs/operacion.md, plano PTY)"; fallo=1
  fi
else
  echo "ROJO relay: no pude leer los logs de ambas salidas"; fallo=1
fi
unset relay_logs

# 7) The unauthenticated governance probe must be denied over verified TLS.
if code="$(curl -sS --cacert "$CONSOLE_CA" --max-time 10 -o /dev/null -w '%{http_code}' "$CONSOLE/v3/console/agents/zeus/documents" 2>/dev/null)"; then
  case "$code" in
    401|403) echo "OK  ruta documents responde $code (existe y exige autenticacion)" ;;
    *) echo "ROJO ruta documents: $code (respuesta inesperada)"; fallo=1 ;;
  esac
else
  echo "ROJO ruta documents: consulta HTTP fallida"; fallo=1
fi

echo
echo "== MANUAL (el dueño): editar un fichero de gobierno desde la consola y verificarlo DENTRO del"
echo "   contenedor (docker exec <c> cat <ruta>); abrir una TUI y verla viva >60s."
exit $fallo
