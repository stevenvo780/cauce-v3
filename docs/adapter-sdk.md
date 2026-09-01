# Adapter SDK — el consumidor durable

El paquete `@cauce/adapter-sdk` conecta un agente CLI real (Claude Code, Codex, OpenClaw, etc.) al bus de Cauce mediante un WebSocket durable de larga vida y ejecución sobre la sesión tmux del harness. Ver [arquitectura.md](arquitectura.md) §2.3 y §3 para el contexto general.

## Transporte

- Un único WS de larga vida contra el gateway con `hello` (tenant/alias/instance/capabilities).
- Cada delivery se persiste localmente **antes** de ejecutarse.
- Los ACKs (`accepted → started → done|failed`) se correlacionan por `event_id` + `delivery_id` + `attempt` + `claim_token` (nunca por orden FIFO).
- Reconexión y redelivery reutilizan los mismos IDs — un duplicado del mismo intento nunca se ejecuta dos veces.
- Backoff exponencial ante fallos de conexión.

## Modelo de ejecución

Entregar = pegar texto en la sesión tmux viva del harness (`paste-runner.ts`, `tmux.ts`: cuarentena de panel, barrera de entrada) y esperar el turno del modelo. Esta es la parte costosa e inherentemente frágil: los errores típicos en producción provienen del turno del harness (ACK timeout, deadline exceeded), no del bus.

## Componentes clave

| Componente | Propósito |
|---|---|
| `sdk/engine.ts` | Loop principal: claim → ACK → pegar texto |
| `sdk/client.ts` | Cliente WebSocket con hello/heartbeat/fencing |
| `sdk/websocket-transport.ts` | Capa de transporte con reconexión |
| `sdk/durable-store.ts` | Persistencia local exacta de deliveries, ACKs e historial terminal |
| `sdk/process-runner.ts` | Ejecución spawn-based para Claude/Codex |
| `sdk/openclaw-api-runner.ts` | Ejecución API-based para OpenClaw |
| `sdk/fanin-synthesizer.ts` | Materializa respuestas de cadenas de delegación A→B→C |
| `sdk/artifact-inliner.ts` | Inlinea artifacts en el contenido del delivery |
| `sdk/output-parser.ts` | Parsea la salida del modelo en respuestas estructuradas |
| `shared-session/paste-runner.ts` | Pega texto en tmux con marcadores de bloque |
| `shared-session/tmux.ts` | Gestión de sesión tmux |

## Harnesses (binarios en `src/bin/`)

| Binario | Estado |
|---|---|
| `claude.ts` | Producción — usado por la flota |
| `codex.ts` | Producción — usado por la flota |
| `openclaw.ts` | Producción — usado por la flota |
| `hermes.ts` | Sin usuario en producción |
| `opencode.ts` | Sin usuario en producción |
| `fake.ts` / `fake-harness.ts` | Solo testing |

Cada harness → `runCli()` → monta `DurableStore` + `HarnessAdapter` sobre el runner correspondiente.

## Persistencia local exacta

`inbox.json` conserva como máximo 256 terminales confirmados por defecto. Al superar el límite,
los más antiguos pasan a segmentos append-only, owner-only y direccionados por SHA-256 dentro de
`terminal-history/`; el inbox vuelve hasta la mitad del límite para evitar reescribir un fichero sin
cota en cada ACK. Nunca se archivan eventos pendientes ni contexto de fan-in retenido, y el historial
no usa TTL ni borrado silencioso: duplicados, colisiones, intentos y `claim_token` antiguos siguen
vallados después de reiniciar. El WAL incluye el digest exacto antes de retirar cada registro del
inbox y la apertura falla cerrada ante corrupción o permisos inseguros.

El historial es acotado en coste de reescritura, no en retención total: los segmentos crecen con
los terminales y hoy no tienen recolección. La apertura valida todos los segmentos y mantiene el
último registro exacto de cada `delivery_id` en memoria, por lo que RAM y tiempo de arranque son
O(historial); un índice durable y carga perezosa quedan como rediseño pendiente. Después de la
primera compactación no es seguro volver a una versión del SDK que desconozca
`terminal-history/`, porque esa versión vería solo el inbox inline; cualquier rollback debe
conservar un binario compatible con este formato.

## La cadena: supervisor → runtime → harness

- **Supervisor** (`ops/scripts/container-adapter-supervisor.sh`): invocado por la unidad systemd del alias; resuelve config/bundle/PKI, valida el bind del contenedor, ejecuta con lock.
- **Runtime** (`ops/container-runtime/cauce-container-runtime.py`): corre dentro del contenedor; gestiona metadatos de generación/PID y falla cerrado si el PID de la generación actual no existe.
- **Harness**: el binario SDK que conecta al bus y ejecuta deliveries.

## Inyección de contexto

- **Contexto nativo de perfil** (`context/native-profile-context.ts`): inyecta `CLAUDE.md`/`AGENTS.md`/etc. como archivos de contexto nativos del harness (actualmente OFF — 4 blockers en [roadmap.md](roadmap.md) §1).
- **Contexto fijo** (`harnesses/contexto-fijo.ts`): contexto estático por tipo de harness.

### Siembra no fatal

Al recibir `hello_ack`, `sdk/client.ts` siembra el perfil del agente en los ficheros del arnés. **Esa siembra no puede costar la conexión**, y esa decisión es deliberada.

Antes lanzaba un `PROFILE_SEED_FAILED` reintentable, que cerraba la conexión antes de reclamar una sola entrega. El problema es que hay fallos de siembra que el adaptador **no puede resolver por sí mismo**: el caso común es una revisión de perfil subida desde la consola que todavía no se aplicó al disco. La guarda de `siembra-del-perfil.ts` se niega entonces a escribir («sólo el publicador durable puede cambiarla»), y el adaptador reintentaba contra un desajuste que sólo un operador humano podía deshacer.

Medido en producción el 01-09-2026 sobre el alias `zeus`: **1.074 reconexiones en 8 h 52 min**, todas muriendo en el mismo punto, con cada mensaje dirigido a ese alias caducando en la cola. El dueño no se enteró porque el bus le acusaba recibo igualmente.

El intercambio elegido: correr con un perfil desactualizado es un problema de *contenido*; quedarse sordo **y callado** es peor. Por eso el fallo ahora es ruidoso en tres sitios —línea de log, `onError('PROFILE_SEED_FAILED')` para las superficies del operador, y un evento `connection_degraded`— y el alias sigue consumiendo con el perfil anterior.

Dos detalles que sostienen esto:

- `backoff.reset()` corre **antes** de sembrar. El backoff mide la salud del *transporte*, y un `hello_ack` ya la demuestra. Reseteándolo después, un fallo de siembra dejaba el retardo clavado en su techo mientras durase.
- `resumenDeLaSiembra` incluye el **motivo** de cada fichero que no se pudo escribir, no sólo el recuento. El recuento a secas (`no-se-pudo-escribir=1`) se registró más de mil veces durante el apagón sin decir nunca cuál de las dos ramas de fallo se había disparado.

## Tests

La suite usa `node:test`. Ejecutar:

```bash
pnpm --filter @cauce/adapter-sdk test
```
