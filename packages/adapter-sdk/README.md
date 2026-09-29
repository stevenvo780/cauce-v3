# @cauce/adapter-sdk

Conecta un agente CLI real a Cauce: consumidor durable + ejecución sobre la sesión del harness.

**Transporte:** un WS de larga vida contra el gateway con hello (tenant/alias/instance/capacidades); toda entrega se persiste localmente ANTES de ejecutarse; los ACKs (`accepted → started → done|failed`) se correlacionan por `event_id`+`delivery_id`+`attempt`+`claim_token` (nunca por orden FIFO); reconexión y reentrega reusan los mismos IDs — un duplicado del mismo intento jamás ejecuta dos veces.

**Historial local:** `inbox.json` queda acotado y los terminales confirmados migran a segmentos append-only owner-only direccionados por SHA-256. El historial exacto no expira: mantiene deduplicación, colisiones, intentos y fencing después de reiniciar; eventos pendientes y contexto fan-in retenido permanecen inline. La retención total sigue creciendo en disco, RAM y coste de apertura; tras compactar, el rollback requiere una versión que entienda `terminal-history/`.

**Ejecución:** entregar significa **pegar el texto en la sesión tmux viva** del harness (`paste-runner.ts`, `tmux.ts`: cuarentena de panel, barrera de input) y esperar el turno del modelo. Es la parte cara e inherentemente frágil del diseño: el error típico de producción es del turno del harness (timeouts de ACK, deadline excedido), no del bus.

**Ejecutables (`src/bin/`):** uno por harness soportado — `openclaw`, `claude`, `codex`, `hermes`, `opencode` — más `fake` y `fake-harness`, que sólo usan los tests. Un ejecutable que ningún alias arranca es candidato a retiro con `git rm`: git es el archivo.

**Despliegue:** la versión activa de cada adaptador se acredita contra la flota viva; no se infiere desde este README.

**Probar:** `pnpm --filter @cauce/adapter-sdk test` (`node:test`).

## Muse Code (MSP)

`cauce-adapter-muse` usa `@muse-code/sdk` para hablar con `muse serve --trust-workspace` por MSP. Cauce guarda un UUIDv7 por ámbito de conversación y reanuda la sesión nativa en cada entrega. El consumidor conserva su barrera durable anterior a la invocación; si el turno queda sin terminal acreditado, lo marca ambiguo y no reenvía el prompt automáticamente.

El arranque por entorno exige `CAUCE_MUSE_EXECUTABLE`, `CAUCE_MUSE_CONFIG_HOME`, `CAUCE_MUSE_DATA_HOME` y `CAUCE_MUSE_WORKSPACE` como rutas absolutas. Los dos directorios XDG deben ser hermanos bajo el HOME persistente del alias. `CAUCE_MUSE_MODEL` y `CAUCE_MUSE_REASONING_EFFORT` son opcionales. `CAUCE_MUSE_APPROVAL_MODE` acepta `denyUnmatched` (valor por defecto), `onRequest` y `allowAll`. `CAUCE_MUSE_YOLO=1` exige `allowAll` y arranca `muse serve` con `--disable-sandbox`; ambos valores se rechazan si aparecen separados. Hospital usa esa combinación solo para Teseo y Perseo, dentro de contenedores con estado y workspace aislados. Para Hospital el workspace debe ser exactamente `/home/node/clawd` y resolver a sí mismo; el host no arranca si allí o en el HOME aislado aparecen directorios personales `.claude` o `.codex`.

El adaptador siembra el bloque gestionado en `AGENTS.md` del workspace medido, conservando las instrucciones manuales. Muse necesita un login propio en su XDG config; el paquete nunca copia credenciales de otro arnés. El binario y la cuenta reales se prueban en el host de despliegue, mientras la suite local usa un host MSP sintético sin credenciales.

## Emisión mediante MCP

El adaptador abre `<stateDirectory>/mcp-emission.sock` bajo su lease local, con permisos `0600`.
Cada alias necesita su propio directorio de estado y su propia configuración MCP. El ejecutable
`cauce-mcp` es un puente stdio que se conecta a ese socket en cada llamada: puede permanecer abierto
en una CLI persistente mientras se reinicia el adaptador. No recibe credenciales ni accede a SQL.
La configuración genérica del servidor usa `command: "node"` y estos argumentos:

```json
["/ruta/al/release/packages/adapter-sdk/dist/src/bin/cauce-mcp.js", "/ruta/al/estado-del-alias/mcp-emission.sock"]
```

Registrar ese servidor en la configuración nativa del harness y recargar su sesión, con el alias
drenado, es parte del despliegue. Cambiar el bundle del adaptador por sí solo no registra herramientas
en una CLI que ya estaba abierta. Los argumentos deben resolver dentro del contenedor del alias.

`cauce_send`, `cauce_notify` y `cauce_artifact_add` preparan salidas. `cauce_reply` deposita una sola
respuesta: un segundo intento se rechaza; el error de una entrada inválida no cambia el depósito y
permite corregirla. No se admiten identidad, epoch ni claim como argumentos. El engine mantiene
esas claves y rechaza llamadas sin turno activo, tras cancelación o ante varios turnos simultáneos.
El shim transporta un ticket interno del turno, sin pedirlo al modelo. El servidor captura además
el turno al recibir las cabeceras HTTP: un cuerpo demorado no puede adoptar una entrega posterior.
En la TUI compartida habilita la emisión después del pegado y Enter confirmados.
Si la respuesta declara `failed`, retira las delegaciones preparadas e informa cuántas descartó;
las notificaciones al humano permanecen, como en el contrato del ACK existente.

`cauce_status` distingue un depósito de un envío confirmado. `cauce_queue` consulta exclusivamente
la cola entrante del alias mediante el gateway. `cauce_progress` usa el claim del turno actual;
`cauce_retry` solicita al gateway repetir una delegación propia en estado `dead`. El gateway vuelve
a validar propiedad y fencing para esas operaciones.

El depósito se sincroniza a disco en `mcp-emission/` antes de confirmar la herramienta. El ACK se
genera al terminar la CLI y sigue usando el outbox durable existente. Si hubo respuesta MCP, el
texto final puede ser prosa o estar truncado: no sustituye el resultado depositado. Sin respuesta
MCP válida se conserva el parser del sobre textual. El log `emission_result` distingue
`mcp_deposit` y `text_fallback` para medir la transición.

Si el adaptador muere entre depósito y cierre de la CLI, conserva el resultado para recuperación;
no declara la entrega completada sin haber observado ese cierre. En sesiones compartidas el nonce
es interno y queda unido a un recibo local. Al recuperar una cuarentena de la misma generación con
el panel ocioso, rescata ese recibo en `resultados-tardios/` aunque la CLI nunca imprimiera un sobre.
Un depósito local no autoriza por sí solo a reproducir trabajo ni a emitir un ACK para otro claim.
