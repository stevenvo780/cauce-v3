# Contratos del núcleo (resumen operativo)

**Spec**: [spec.md](../spec.md). Detalle canónico en `services/gateway/src/`
y `packages/protocol/`; aquí sólo el contrato que la validación ejerce.

## HTTP (gateway)

| Método + ruta | Efecto | Fencing / errores |
|---|---|---|
| `POST /v3/connections/hello` | adquiere lease, devuelve `epoch` + `connection_token` | 409 si el lease está tomado; token UUID RFC o `fenced` |
| `POST /v3/deliveries/query` | reclama entregas sin estado | exige lease vigente |
| `POST /v3/query` | reclamo alternativo sin estado | idem |
| `POST /v3/heartbeat` | renueva lease | lease vencido → re-hello |
| rutas ACK | `accepted>started>done\|failed` | `event_id`+`claim_token`+intento deben coincidir |
| `GET /health/ready` | `ready` cuando migra + sirve | sonda de compose y k8s |

## WS

`GET /v3/ws`: hello → acquireLease → heartbeat → hello_ack con epoch; drena
reclamos con topes de admisión. Cerco roto → error + cierre 4401. ACK de epoch
vieja sólo se rescata si es terminal.

## Terminal (relay, plano de datos, sin BD)

WS `/v3/console/terminal/relays/{id}/ws`; primer frame `attach|resume` JSON;
ticket verificado por el gateway (el relay no guarda claves). Cable agente
`[tag:1][len:4BE][payload]`, tope 64 KiB; tag desconocido corta la conexión.

## Telegram (bridge)

Ingreso `getUpdates` → buffer/álbum → `runBatch` → store; egreso por worker
único con lease. Comandos de operador con respuesta rápida (opt-in).
