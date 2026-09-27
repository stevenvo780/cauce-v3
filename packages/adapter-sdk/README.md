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

El arranque por entorno exige `CAUCE_MUSE_EXECUTABLE`, `CAUCE_MUSE_CONFIG_HOME`, `CAUCE_MUSE_DATA_HOME` y `CAUCE_MUSE_WORKSPACE` como rutas absolutas. Los dos directorios XDG deben ser hermanos bajo el HOME persistente del alias. `CAUCE_MUSE_MODEL` y `CAUCE_MUSE_REASONING_EFFORT` son opcionales. `CAUCE_MUSE_APPROVAL_MODE` solo acepta `denyUnmatched`, también su valor por defecto: una herramienta sin autorización recibe una denegación visible para el modelo en lugar de bloquear indefinidamente la entrega. Las solicitudes de aprobación residuales se responden con la opción de denegar ofrecida por Muse. La sandbox permanece activa. Para Hospital el workspace debe ser exactamente `/home/node/clawd` y resolver a sí mismo; el host no arranca si allí o en el HOME aislado aparecen directorios personales `.claude` o `.codex`.

El adaptador siembra el bloque gestionado en `AGENTS.md` del workspace medido, conservando las instrucciones manuales. Muse necesita un login propio en su XDG config; el paquete nunca copia credenciales de otro arnés. El binario y la cuenta reales se prueban en el host de despliegue, mientras la suite local usa un host MSP sintético sin credenciales.
