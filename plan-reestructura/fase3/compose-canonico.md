# El compose canónico único — qué debe tener exactamente

Origen: reconciliación renderizada (`docker compose config`) entre `/opt/cauce-v3/deploy/compose.yaml` + 4 overrides activos de `/etc/cauce-v3/compose-overrides/` (lo que corre) y `deploy/compose.yaml` del repo (el canónico a escribir). Base: **el fichero del repo**, con estos cambios.

## AÑADIR (trabajo hecho a mano en prod que nunca subió al repo — `git log -S` lo confirma)

1. `gateway.environment` += `CAUCE_DELIVERY_LEASE_CAP_MS: ${CAUCE_DELIVERY_LEASE_CAP_MS:-21600000}` — sin declararla, la de prod.env NO llega al contenedor y el código cae a su default de 12h; gateway y dispatcher DEBEN leer el mismo valor.
2. `gateway.environment` += `CAUCE_MAX_INFLIGHT_DELIVERIES` y `CAUCE_HUMAN_RESERVED_DELIVERIES` (hoy 2 y 2).
3. `dispatcher.environment` += `CAUCE_DELIVERY_LEASE_CAP_MS` (el código exige ≥ `CAUCE_ACK_DEADLINE_MS`).
4. `telegram-bridge.environment` += las cuatro `CAUCE_TELEGRAM_TRANSCRIPTION_{URL,MODEL,LANGUAGE,TIMEOUT_SECONDS}` — **sin esto se APAGA la transcripción de notas de voz** (servicio GPU en `http://100.64.0.1:8010/v1`).

## CORREGIR defectos del fichero del repo

5. `terminal-relay`: CN `…console-client},gateway-client` — el `gateway-relay-client` del repo NO casa con el certificado real emitido (`CN=gateway-client`); con el del repo el relay rechaza el saludo TLS del gateway.
6. `gateway`: borrar `CAUCE_TERMINAL_GATEWAY_CLIENT_{CERT,KEY}_FILE` — ningún código del gateway las lee y apuntan a secretos que no monta.
7. Secretos `gateway_relay_client_{cert,key}`: default `/dev/null` → `/etc/cauce-v3/pki/gateway-client.{crt,key}` (o variables en prod.env). Tal cual, el render da `/dev/null` y la lectura de gobierno vuelve a «NO SE PUDO MIRAR» (B3).
8. `CAUCE_TERMINAL_RELAY_INSTANCE_ID`: de `${…:-}` a `${…:?}` fail-closed y valor en prod.env. Valor candidato medido (sha256 del DER del leaf): `749f8af81ce316c6e28c3c7ac200640ea1b918ac12b653193864f5d61f4c520b`. Ojo: también es build-arg del nginx de consola y LABEL del Dockerfile — es contrato de release, no variable suelta (B2).
9. Secreto `release_state` de outbox-metrics: hoy es un `:?` fail-closed atado a la maquinaria de release retirada. Degradar a opcional y quitar el `required()` de `deploy/outbox-metrics.mjs:28`, o decidir conservar el snapshot-writer.

## BORRAR (deriva/legado)

10. Servicios `relay-worker`, `shadow-router`, `shadow-guard` completos + secreto `relay_provider_module` + variables `CAUCE_RELAY_*`/`SHADOW_*` + job `cauce-origin-relay` de prometheus.yaml (+ `deploy/shadow-guard.mjs`).
11. `deploy/Dockerfile`: quitar COPY/`--filter` de relay-worker y shadow-router (líneas 18-19, 48-49, 57-58, 90-91) — **el build está roto HOY por esto**.

## CONSERVAR novedades buenas del repo (nunca ejecutadas, justificadas)

`restart: unless-stopped` · volumen `terminal_close_spool` + su variable · `CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: "150"` (gateway Y relay a la vez) · `CAUCE_TERMINAL_PRESENCE_MAX_STALE_SECONDS: "30"` · health port 8085 del relay · `CAUCE_DISPATCHER_STALE_MS` · las tres `CAUCE_TELEGRAM_*_MS` · `deploy.replicas: 1` + label de routing del relay · forma larga de secretos con uid/gid/mode.

**Healthcheck del relay, condicionado:** con imagen nueva horneada en la ventana → el del repo (`local-readiness-probe.mjs` + :8085). Si por lo que sea se migrara sobre las imágenes VIEJAS → conservar el bloque TLS de `/opt:288-296` o el relay queda unhealthy y la consola no arranca (B4: el probe nuevo no existe en las imágenes viejas).

## Overrides: destino final

| Override | Destino |
|---|---|
| `terminal-minrows.yaml` | borrar (ya inerte; el fix está portado) |
| `dispatcher-hotfix.yaml` | borrar (obsoleto por su propio texto) |
| `mudanza-pin-digests.yaml` | borrar; su HECHO (outbox-metrics corre imagen distinta) lo absorbe el up canónico |
| `directiva-20260825.yaml` | se absorbe en el canónico; el pin de imagen lo reemplaza `CAUCE_RUNTIME_IMAGE` |
| `telegram-bridge.active.yaml` | 5 de sus 6 parches .js SOBRAN con main; `protocol-schemas-regex` NO (ver pre-ventana-codigo.md) |
| `store-fanin.yaml` | NO sobra hasta portar fan-in y auditar `store-repository.js` (pre-ventana-codigo.md) |
| `mudanza-arranque-sin-gate-de-salud.yaml` | conservar como escotilla suelta (último `-f` en emergencia) |

## Secretos y side-files que el deploy simple debe respetar (rutas exactas)

- Entorno: `/etc/cauce-v3/prod.env` (borrar sus 3 líneas rancias de relay-cert que apuntan al certificado de SERVIDOR).
- PKI: `/etc/cauce-v3/pki/` (ca, gateway, console, console-client, gateway-client, postgres).
- Secretos: `/etc/cauce-v3/secrets/` (database_url, console_jwt_key, oidc_*, terminal-ticket.key, terminal-relay.{token,crt,key}, terminal-gateway-client.{crt,key}).
- Binds de DIRECTORIO (rotación por rename atómico): `secrets/identities→/run/cauce-identities` · `terminal→/run/cauce-terminal` · `telegram-runtime→/run/cauce-telegram` · `/srv/cauce/media→/run/cauce-media`.
- Higiene: sacar los `.bak` de identidad mTLS de DENTRO de los directorios montados (el propio compose lo prohíbe y hay 5); borrar `/etc/cauce-v3/compose-overrides/active.manifest/` (directorio vacío fósil).
- D3 (dueño): correr desde el repo o desde /opt — cambia el source de 4 binds (`../ops/observability/*.yaml`, `./postgres-tls-entrypoint.sh`).
