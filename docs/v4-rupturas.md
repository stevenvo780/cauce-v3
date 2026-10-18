# Rupturas reales y diagnóstico de V4

Estos ensayos verifican diagnóstico **local**, con PostgreSQL creado por Testcontainers,
gateway con autenticación humana, SSH, procesos de terminal y Git reales. Los datos son
sintéticos; la base de pruebas conserva los nombres del catálogo inicial. No acreditan
el despliegue ni la operación de las empresas productivas.

| Ruptura provocada | Identificador de seguimiento | Componente | Causa saneada encontrada | Consulta del operador |
|---|---|---|---|---|
| Matar el servidor SSH y sus hijos mientras el executor ejecuta `stop` | `operation_id` | `fleet.executor` | `STEP_FAILED`, paso `stop`; SSH sale con 255 y conexión cerrada | `cauce diagnose "$OPERATION_ID"` y `rg -F "operation_id=$OPERATION_ID" executor.log` |
| Matar el contenedor propio de un agente con PTY abierto y salida comprobada | `session_id`, con su `trace_id` en la cadena | `terminal-relay` | `agent_disconnected`; WebSocket cerrado con 4404 | `jq -c 'select(.event == "terminal_relay_session_closed" and .session_id == env.SESSION_ID)' terminal-relay.log`; diagnóstico HTTP por sesión |
| Ejecutar dos veces `cauce context edit` con la misma versión esperada | `reqId` y `pid` del gateway | `gateway` | `conflict`; petición PUT de contexto rechazada con HTTP 409 y CLI sale con 1 | `jq -c 'select(.reqId == env.REQUEST_ID and .pid == (env.GATEWAY_PID | tonumber))' gateway.log` |
| Adelantar un remoto bare real y empujar desde otro broker que conserva un fetch anterior | tenant, alias, versión y commit retenido | `context` | `context_git_non_fast_forward` | Auditoría por empresa filtrada por `action=context.sync` y alias; estado del contexto por tenant y alias |

El diagnóstico CLI necesita `--gateway`, `--origin` y `--session-file`; el fichero de sesión
debe ser privado y pertenecer al usuario. Las consultas HTTP usadas son:

```text
GET /v3/console/diagnose/<operation_id o session_id>
GET /v3/console/audit?action=context.sync&alias=<alias>&limit=100
GET /v3/console/context/agents/<tenant>/<alias>/status
```

La causa del terminal se obtiene del log del relay: el diagnóstico devuelve la sesión
cerrada y sus eventos, pero omite el texto libre de cierre. La auditoría de contexto devuelve
el código del rechazo; la consulta de estado identifica la versión y el commit retenido.
Los identificadores `reqId` del gateway son locales a su proceso: el ensayo conserva también
`pid` y `time` para acotar la búsqueda en sus logs.

## Correcciones comprobadas

El fallo del transporte de flota no incluía el identificador de operación en su log.
Ahora propaga `operation_id`, componente y host; utiliza el host del scope cercado o el
único host del estado anterior. Si el host no puede determinarse, escribe `unknown`.
El saneador de stderr existente sigue suprimiendo secretos y acotando la salida.
La regresión reprodujo la ausencia del identificador antes del cambio.

Los rechazos `StoreError` del gateway sólo dejaban el estado HTTP en el log. Ahora añaden
`console_request_rejected`, el componente y el código tipado del error bajo el mismo
`reqId`. No se registran el mensaje libre, el cuerpo del contexto, cookies ni credenciales.

## Repetición y recibos

Desde la raíz del checkout:

```sh
pnpm exec vitest run services/gateway/src/fleet/host-stderr.test.ts services/gateway/src/fleet/host-command.test.ts tests/integration/v4-rupturas-postgres.test.ts tests/e2e/v4-rupturas-terminal-cli.test.ts --testTimeout=300000
pnpm exec vitest run services/gateway/src/routes/shared.test.ts
pnpm typecheck
```

Los cuatro ensayos emiten una línea `V4_RUPTURE_RECEIPT` con identificador, componente,
causa, comando realmente ejecutado y evidencia operativa saneada. El recibo consolidado
se conserva en `.delegados/v4/recibos/rupturas-<sha>.json`, junto a los logs durables del
carril. La tabla anterior describe las consultas; el JSON conserva los comandos exactos,
puertos y rutas efímeras de la ejecución. Sus servicios y ficheros de sesión se eliminan
al terminar, por lo que esas direcciones no representan servicios persistentes.

Las fixtures reutilizan los simulacros de SSH y Git existentes. La ruptura de SSH usa
el executor y transporte reales con un proceso remoto de prueba; la de terminal usa
gateway, relay y agente Python reales. Ninguno de los cuatro ensayos sustituye componentes
por mocks. Después del rechazo Git se verifica la recuperación a `synced`. Las limpiezas
cierran bases y procesos propios, y el ensayo terminal verifica ID y etiqueta del
contenedor antes de matarlo. La publicación y la verificación desplegada corresponden
al integrador autorizado, siguiendo el [gate vigente](operacion.md#desplegar-v4).
