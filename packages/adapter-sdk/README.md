# @cauce/adapter-sdk

Conecta un agente CLI real a Cauce: consumidor durable + ejecución sobre la sesión del harness.

**Transporte:** un WS de larga vida contra el gateway con hello (tenant/alias/instance/capacidades); toda entrega se persiste localmente ANTES de ejecutarse; los ACKs (`accepted → started → done|failed`) se correlacionan por `event_id`+`delivery_id`+`attempt`+`claim_token` (nunca por orden FIFO); reconexión y reentrega reusan los mismos IDs — un duplicado del mismo intento jamás ejecuta dos veces.

**Historial local:** `inbox.json` queda acotado y los terminales confirmados migran a segmentos append-only owner-only direccionados por SHA-256. El historial exacto no expira: mantiene deduplicación, colisiones, intentos y fencing después de reiniciar; eventos pendientes y contexto fan-in retenido permanecen inline. La retención total sigue creciendo en disco, RAM y coste de apertura; tras compactar, el rollback requiere una versión que entienda `terminal-history/`.

**Ejecución:** entregar significa **pegar el texto en la sesión tmux viva** del harness (`paste-runner.ts`, `tmux.ts`: cuarentena de panel, barrera de input) y esperar el turno del modelo. Es la parte cara e inherentemente frágil del diseño: el error típico de producción es del turno del harness (timeouts de ACK, deadline excedido), no del bus.

**Ejecutables (`src/bin/`):** `openclaw`, `claude`, `codex` — los que usa la flota real. `hermes`, `opencode` y `fake` no tienen ningún usuario en producción (candidatos a retiro con `git rm` — git es el archivo; `fake` y `fake-harness` los usan los tests). `grok` es nuevo y todavía no tiene alias (ver abajo). `muse` tiene dos transportes (ver «Arnés `muse`»).

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
  (nunca elige sola entre DM, delegaciones o ramas). La conversación canónica se nombra con
  `SHARED_SESSION_NATIVE_ID=<id>` en el `.env` del alias: el adaptador la siembra él mismo al
  arrancar, con la release que corre (sólo si no hay puntero; nunca lo pisa). `shared-session.js
  seed` sigue existiendo, pero sólo sirve desde una release que ya esté en el contenedor. Tras cada
  turno cerrado el testigo mueve el puntero con CAS (así un `/new` en la TUI se sigue).
- **Transcript:** `$GROK_HOME/sessions/<cwd>/<id>/updates.jsonl` de TODOS los cwd (`--resume`
  reabre la conversación en la carpeta donde nació), sin las sesiones de subagentes
  (`summary.json` `session_kind: "subagent"`, una carpeta por subagente que nadie poda) y acotado a
  las `MAX_GROK_SESSIONS` escritas más recientemente (nunca a una lista vacía). El prompt se
  reconoce por texto (también envuelto en `<user_query>`) o por el `cauce_correlation_id` que generó
  el ejecutor (nunca por uno escrito dentro del pedido).
- **Fin de la entrega = fin del TRABAJO, no del primer turno.** En la TUI los subagentes y los
  comandos en segundo plano sobreviven al turno y lo despiertan (`will_wake`) con un turno nuevo;
  escribir mientras el turno espera en `get_command_or_subagent_output` lo CANCELA. La entrega sigue
  lo que su turno lanzó (`subagent_spawned.parent_prompt_id`, `task_backgrounded` → `tool_call`) y
  los turnos de despertar que eso causa, y cierra cuando todo terminó: la respuesta es la del último
  turno de esa cadena (texto tras su última herramienta) o, si lo hubo, el depósito `cauce_reply`,
  que un cancelled posterior ya no tira. Si el trabajo en segundo plano no avanza en
  `backgroundWaitMs` (10 min, el mismo tope que el headless de grok) se entrega lo que había con el
  aviso `background_pending`. Mientras la entrega sigue abierta, `cauce_reply` de un despertar se
  acepta. No medido: la forma exacta del prompt de un despertar (se asume sin línea de usuario; si la
  tuviera, la entrega espera hasta ese tope y entrega el depósito).
- **Panel:** turno en curso = pie `Ctrl+c:cancel`. Con el pie de grok a la vista, SÓLO el pie
  decide (una respuesta que cita un spinner o «esc to interrupt» no bloquea el bus); el spinner
  `… [stop]` cuenta sólo si el pie no se ve. grok ENCOLA lo que se pega mientras genera, así que el
  bus sólo toma la caja con la TUI ociosa: espera hasta `generatingWaitMs` (2 h) a que termine el
  turno ajeno —un turno que empieza bajo la barrera devuelve el pedido a esa misma espera— y, si no,
  falla REINTENTABLE con `tui_generating` (nunca culpa al dueño de «texto a medio escribir»).
  Cancelar es `C-c` y sólo si el turno correlacionado está localizado y abierto (nunca el del dueño);
  en ociosa `C-c` arma la salida y Escape no cancela.
- **Pegado:** el cuerpo de una entrega es texto libre de otro alias: ESC, los demás C0 (menos tab y
  salto de línea), DEL y C1 se vuelven sus símbolos visibles (`pasteSafeText`) antes de
  `load-buffer`, así un `ESC[201~` no cierra el pegado entre corchetes ni convierte el resto en teclas.
- **Operación:** tmux dentro del contenedor y un workspace en el que grok confíe sin diálogo:
  `SHARED_SESSION_WORKSPACE=$HOME` (el cwd del headless) está permitido aunque `$HOME` no sea un
  montaje persistente, porque la conversación vive en `~/.grok`. Sin tmux el supervisor arranca el
  adaptador headless y lo dice (antes moría con 78 y Telegram quedaba mudo). `cauce-attach` (única
  fuente: `ops/guardias/cauce-attach`) se niega a abrir un segundo grok sobre un alias compartido.
- **Orden de despliegue seguro** (el supervisor y `update_alias_lib.py` vivos rechazan
  `SHARED_SESSION` para grok con `die` 2, que systemd no reintenta):
  1. Desplegar primero el árbol `ops` de esta rama (ya fusionada con `main`, con el alta de hades)
     e instalar el CLI con `ops/scripts/install-cauce-cli.sh`.
  2. tmux en la imagen: construir una imagen NUEVA (no re-etiquetar `claw:latest`, que fija por ID
     a otros siete alias) y poner su ID en `EXPECTED_IMAGE_ID` de `hades.env` ANTES de recrear el
     contenedor; si no, el supervisor lo rechaza (`container image ID is not allowlisted`).
  3. En una sola edición de `hades.env`: `BUNDLE_RELEASE`/`BUNDLE_SHA256` nuevos, `SHARED_SESSION=1`,
     `SHARED_SESSION_WORKSPACE=/home/claw` y `SHARED_SESSION_NATIVE_ID=<id del DM>`; un solo
     reinicio. El adaptador siembra el puntero con su propia release.
  4. Recién con la release nueva dentro del contenedor, re-registrar el MCP `cauce` con su ruta
     (`grok mcp add cauce --scope user -- node <release>/…/cauce-mcp.js …`): antes apuntaría a un
     fichero que no existe.

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

`cauce-decisiones-mcp` es un segundo servidor, separado, con los mismos dos argumentos. Expone
`listar_plantillas`, `decidir_plantilla` y `decidir`, y usa la ruta `POST /decisiones` del mismo
socket. Esa ruta no necesita turno y no pasa por la cola de emisión. El adaptador la reenvía al
servicio de decisiones (`CAUCE_DECISIONES_URL`, un origen https) con el certificado mTLS del alias. Sin
esa variable responde `decisiones_no_configurado`. Registrarlo no activa `cauce_*` en un alias que no
los tenga. El contrato está en `services/decisiones/README.md`.

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

## Arnés `muse` (Muse Code): dos transportes

**Por defecto — `muse exec` (el que corre en producción, alias `hegel`).** El comando es el puente
`muse-cauce exec --json --yolo --trust-workspace`: copia el prompt de stdin a un fichero regular
(`--prompt-file` rechaza un pipe) y el parser lee el JSONL (`run_terminal`, con `run_output_delta`
como respaldo). La sesión se observa en el stream y se reanuda con `--session-id`. Con
`SHARED_SESSION=1` la entrega va a la TUI real en tmux (`--reasoning-effort max`), con un
`XDG_DATA_HOME` propio del alias; «Double checking» no cuenta como turno fundido.

**Opcional — MSP (`muse serve`, Hospital).** Se activa sólo con configuración explícita:
`CAUCE_MUSE_EXECUTABLE` en el entorno o un bloque `muse` en el fichero de configuración. Sin eso,
un alias `muse` sigue exactamente por el camino anterior. `cauce-adapter-muse` carga entonces
`@muse-code/sdk` (sólo en ese modo) para hablar con `muse serve --trust-workspace` por MSP. Cauce guarda un UUIDv7 por ámbito de conversación y reanuda la sesión nativa en cada entrega. El consumidor conserva su barrera durable anterior a la invocación; si el turno queda sin terminal acreditado, lo marca ambiguo y no reenvía el prompt automáticamente.

En modo MSP el arranque por entorno exige `CAUCE_MUSE_EXECUTABLE`, `CAUCE_MUSE_CONFIG_HOME`, `CAUCE_MUSE_DATA_HOME` y `CAUCE_MUSE_WORKSPACE` como rutas absolutas. Los dos directorios XDG deben ser hermanos bajo el HOME persistente del alias. `CAUCE_MUSE_MODEL` y `CAUCE_MUSE_REASONING_EFFORT` son opcionales. `CAUCE_MUSE_APPROVAL_MODE` acepta `denyUnmatched` (valor por defecto), `onRequest` y `allowAll`. `CAUCE_MUSE_YOLO=1` exige `allowAll` y arranca `muse serve` con `--disable-sandbox`; ambos valores se rechazan si aparecen separados. Hospital usa esa combinación solo para Teseo y Perseo, dentro de contenedores con estado y workspace aislados. Para Hospital el workspace debe ser exactamente `/home/node/clawd` y resolver a sí mismo (un alias `muse` de Hospital sin MSP no arranca); el host no arranca si allí o en el HOME aislado aparecen directorios personales `.claude` o `.codex`.

Salvaguardas de la convivencia: una variable exclusiva de MSP (`CAUCE_MUSE_CONFIG_HOME`,
`CAUCE_MUSE_APPROVAL_MODE`, `CAUCE_MUSE_YOLO`, `CAUCE_MUSE_MODEL`, `CAUCE_MUSE_REASONING_EFFORT`) sin
`CAUCE_MUSE_EXECUTABLE` detiene el adaptador en vez de caer a `exec --yolo`; MSP y `SHARED_SESSION=1`
son excluyentes. `CAUCE_MUSE_DATA_HOME` y `CAUCE_MUSE_WORKSPACE` no seleccionan transporte: la TUI
compartida y la medición de contexto también los leen.

Con `CAUCE_MUSE_WORKSPACE` el adaptador siembra el bloque gestionado en `AGENTS.md` del workspace medido, conservando las instrucciones manuales. Muse necesita un login propio en su XDG config; el paquete nunca copia credenciales de otro arnés. El binario y la cuenta reales se prueban en el host de despliegue, mientras la suite local usa un host MSP sintético sin credenciales (`test/fixtures/fake-muse-msp.mjs`).
