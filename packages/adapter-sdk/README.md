# @cauce/adapter-sdk

Conecta un agente CLI real a Cauce: consumidor durable + ejecución sobre la sesión del harness.

**Transporte:** un WS de larga vida contra el gateway con hello (tenant/alias/instance/capacidades); toda entrega se persiste localmente ANTES de ejecutarse; los ACKs (`accepted → started → done|failed`) se correlacionan por `event_id`+`delivery_id`+`attempt`+`claim_token` (nunca por orden FIFO); reconexión y reentrega reusan los mismos IDs — un duplicado del mismo intento jamás ejecuta dos veces.

**Historial local:** `inbox.json` queda acotado y los terminales confirmados migran a segmentos append-only owner-only direccionados por SHA-256. El historial exacto no expira: mantiene deduplicación, colisiones, intentos y fencing después de reiniciar; eventos pendientes y contexto fan-in retenido permanecen inline. La retención total sigue creciendo en disco, RAM y coste de apertura; tras compactar, el rollback requiere una versión que entienda `terminal-history/`.

**Ejecución:** entregar significa **pegar el texto en la sesión tmux viva** del harness (`paste-runner.ts`, `tmux.ts`: cuarentena de panel, barrera de input) y esperar el turno del modelo. Es la parte cara e inherentemente frágil del diseño: el error típico de producción es del turno del harness (timeouts de ACK, deadline excedido), no del bus.

**Ejecutables (`src/bin/`):** `openclaw`, `claude`, `codex` — los que usa la flota real. `hermes`, `opencode` y `fake` no tienen ningún usuario en producción (candidatos a retiro con `git rm` — git es el archivo; `fake` lo usan los tests). `grok` es nuevo y todavía no tiene alias (ver abajo).

**Despliegue:** la versión activa de cada adaptador se acredita contra la flota viva; no se infiere desde este README.

## Arnés `grok` (Grok CLI, `@xai-official/grok`, medido en 1.0.41)

Headless de un turno, como `opencode`: `grok --prompt-file /dev/stdin --output-format json
--always-approve --verbatim [--resume <sessionId>]`, ejecutable `cauce-adapter-grok`.
`--always-approve` porque en headless nadie aprueba una tool (el turno se bloquearía);
`--verbatim` para que una línea de la petición que empieza por `/` o `@` sea texto y no un comando
o una mención de fichero de Grok.

- **Prompt:** sigue entrando SOLO por fd 0, pero Grok no lee el stream de stdin: únicamente acepta
  el prompt como ruta (`--prompt-file`) o en argv (`-p`, prohibido por el runner). El pipe por
  defecto de libuv es un socketpair y `open("/dev/stdin")` sobre él falla con ENXIO (medido:
  `Error: Failed to read '/dev/stdin': No such device or address (os error 6)`, exit 1). Por eso la
  definición declara `stdinSource: "file"`: el runner respalda fd 0 con un fichero regular 0600 ya
  desenlazado antes de arrancar el proceso.
- **Salida:** un único objeto JSON al terminar (`text`, `stopReason`, `sessionId`, …). `text`
  concatena todo el texto del turno sin separador; `thought` nunca llega a la respuesta. Un
  `stopReason` distinto de `end_turn` o un objeto `{"type":"error"}` es un turno `failed` con el
  mensaje crudo de Grok. Sin testigo de arranque: nada sale por stdout antes del final.
- **Sesiones:** `observed` (`sessionId` → `--resume`). Grok las guarda por directorio de trabajo:
  el alias necesita un `CAUCE_AGENT_WORKSPACE` estable. Una sesión que ni el disco ni el registro
  de xAI conocen sale con exit 1 y `Failed to restore session from remote … 404`: el adaptador la
  olvida y reintenta (`PROCESS_EXIT_PREFLIGHT`). Un fallo de red al restaurar reintenta sin olvidar.
- **Emisión MCP:** Grok no tiene flag de MCP por invocación, así que, como en claude/codex/openclaw,
  el servidor `cauce` se registra en la configuración nativa al desplegar, con scope de usuario
  (el de proyecto exige carpeta "trusted", imposible en headless):
  `grok mcp add cauce --scope user -- node <release>/packages/adapter-sdk/dist/src/bin/cauce-mcp.js <estado-del-alias>/mcp-emission.sock`
  (queda en `~/.grok/config.toml`, verificable con `grok mcp list`). Grok expone las tools a través
  de `search_tool`/`use_tool` como `cauce__cauce_reply`. Sin ese registro, o si el modelo no llama a
  la tool, el turno sigue funcionando por el sobre JSON de respaldo (`emission_result=text_fallback`).
- **Aislamiento:** por defecto Grok también importa de `~/.claude` y `~/.claude.json` los MCP, las
  instrucciones (`CLAUDE.md`), las reglas y los hooks. En un HOME compartido con un alias claude,
  eso le daría a Grok la identidad del vecino y su `cauce` MCP, que apunta al socket de otro alias.
  En el `~/.grok/config.toml` del alias grok hay que poner `mcps`, `agents`, `rules`, `hooks` y
  `skills = false` bajo `[compat.claude]` y `[compat.cursor]`. Dos alias grok no deben compartir
  `~/.grok`.

### Sesión compartida de grok (`SHARED_SESSION=1`)

Igual que claude/codex: UNA sola conversación viva, la TUI real de grok en `tmux -L cauce`
(`cauce-<alias>:agente`), donde el bus pega los pedidos y el dueño entra con `cauce <alias>`.
Sin sesión compartida grok es headless por turno y `cauce <alias>` abre una RAMA (`--fork-session`).

- **Arranque exacto:** `grok --always-approve --resume <id>` con `GROK_HOME` exportado en el panel.
  El id sale del puntero `shared-tui-session.json` del alias (el mismo almacén que claude); sin
  puntero y sin historia arranca `--session-id <uuidv7>`; con historia y sin puntero se BLOQUEA
  (nunca elige sola entre DM, delegaciones o ramas). Migración: sembrar una vez la conversación
  canónica con `shared-session.js seed --alias A --harness grok --workspace W --state S --native-id <id>`
  (sólo escribe si no hay puntero). Tras cada turno cerrado el testigo mueve el puntero con CAS
  (así un `/new` en la TUI se sigue).
- **Transcript:** `$GROK_HOME/sessions/<cwd>/<id>/updates.jsonl` de TODOS los cwd (`--resume`
  reabre la conversación en la carpeta donde nació). El prompt se reconoce por texto (también
  envuelto en `<user_query>`) o por su `cauce_correlation_id`; la respuesta es el texto posterior
  a la última herramienta del turno, que cierra `turn_completed` (`stop_reason` ≠ `end_turn` =
  fallo). Un depósito `cauce_reply` sin texto final cierra en ese mismo `turn_completed`.
- **Panel:** turno en curso = pie `Ctrl+c:cancel` (última línea) o spinner `… [stop]`. grok
  ENCOLA lo que se pega mientras genera, así que el bus sólo toma la caja con la TUI ociosa.
  Cancelar es `C-c` y sólo con un turno en curso (en ociosa arma la salida); Escape no cancela.
- **Operación:** tmux dentro del contenedor (el supervisor lo exige para grok) y un workspace en
  el que grok confíe sin diálogo: `SHARED_SESSION_WORKSPACE=$HOME` (el cwd del headless) está
  permitido aunque `$HOME` no sea un montaje persistente, porque la conversación vive en `~/.grok`.
  `cauce-attach` se niega a abrir un segundo grok sobre un alias compartido (grok no bloquea sesiones).

**Probar:** `pnpm --filter @cauce/adapter-sdk test` (`node:test`).

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
