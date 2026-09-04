# Adapter SDK — el consumidor durable

El paquete `@cauce/adapter-sdk` conecta un agente CLI real (Claude Code, Codex, OpenClaw, etc.) al bus de Cauce mediante un WebSocket durable de larga vida y ejecución sobre la sesión tmux del harness. Ver [arquitectura.md](arquitectura.md) §2.3 y §3 para el contexto general.

## Transporte

- Un único WS de larga vida contra el gateway con `hello` (tenant/alias/instance/capabilities).
- Cada delivery se persiste localmente **antes** de ejecutarse.
- Los ACKs (`accepted → started → done|failed`) se correlacionan por `event_id` + `delivery_id` + `attempt` + `claim_token` (nunca por orden FIFO).
- Reconexión y redelivery reutilizan los mismos IDs — un duplicado del mismo intento nunca se ejecuta dos veces.
- Backoff exponencial ante fallos de conexión.

### Plazos de conexión y reconexión

| Fase | Plazo por defecto | Efecto al vencer |
|---|---:|---|
| `connect` | 30 s | aborta el intento y cierra cualquier conexión que llegue tarde |
| envío de una trama | 15 s desde su entrada en la cola | invalida y cierra esa generación de transporte |
| `hello_ack` | 15 s después de enviar `hello` | invalida y cierra esa generación |
| primer `heartbeat_ack` pendiente | `max(30 s, 2 × heartbeatMs)` | invalida y cierra esa generación |
| lease de conexión | `lease_expires_at` del gateway | cierra 1 s antes si el reloj permite usar ese plazo absoluto |

`connectTimeoutMs`, `sendTimeoutMs`, `helloAckTimeoutMs` y `heartbeatAckTimeoutMs` permiten
sobrescribir los cuatro plazos locales con enteros positivos compatibles con los timers de Node.
El heartbeat usa 15 s por defecto.
El gateway fija el lease; su configuración por defecto es 180 s y no admite menos de 30 s.

Solo un `heartbeat_ack` con una expiración válida y estrictamente posterior renueva el lease,
cancela el plazo del primer heartbeat pendiente y reinicia el backoff. Un ACK inválido o no
creciente no prolonga la conexión. Los envíos posteriores tampoco desplazan el plazo del primer
heartbeat pendiente.

Un `lease_expires_at` pasado o a menos de 1 s puede deberse a sesgo entre relojes. El ACK todavía
demuestra tráfico actual, pero no arma un timer absoluto; en ese caso manda el plazo relativo del
próximo `heartbeat_ack`.

Cada conexión tiene una generación y un `AbortSignal` propios. Un timeout aborta y cierra solo la
generación afectada; una conexión o un envío que termine tarde no puede reemplazar ni fallar la
siguiente. El bucle conserva la identidad durable y reintenta con backoff. El cercado del gateway
se describe en [ADR-002](adr/002-lease-epoch-fencing.md).

## Modelo de ejecución

Entregar = pegar texto en la sesión tmux viva del harness (`paste-runner.ts`, `tmux.ts`: cuarentena de panel, barrera de entrada) y esperar el turno del modelo. Esta es la parte costosa e inherentemente frágil: los errores típicos en producción provienen del turno del harness (ACK timeout, deadline exceeded), no del bus.

## Componentes clave

| Componente | Propósito |
|---|---|
| `sdk/engine.ts` | Loop principal: claim → ACK → pegar texto |
| `sdk/client.ts` | Cliente WebSocket con hello/heartbeat/fencing |
| `sdk/connection-liveness.ts` | Plazos de connect, hello, envío, heartbeat y lease por generación |
| `sdk/websocket-transport.ts` | Capa de transporte con reconexión |
| `sdk/durable-store.ts` | Persistencia local exacta de deliveries, ACKs e historial terminal |
| `sdk/process-runner.ts` | Ejecución spawn-based para Claude/Codex |
| `sdk/openclaw-api-runner.ts` | Ejecución API-based para OpenClaw |
| `sdk/fanin-synthesizer.ts` | Materializa respuestas de cadenas de delegación A→B→C |
| `sdk/artifact-inliner.ts` | Inlinea artifacts en el contenido del delivery |
| `sdk/output-parser/relay-artifacts.ts` | Parsea y acota los `artifacts` de cada mensaje delegado |
| `sdk/engine/turn-cleanup.ts` | Materializa y libera lo que el turno escribe en disco |
| `sdk/secrets.ts` | Abre los traspasos sellados dirigidos a este alias |
| `sdk/engine/secret-guard.ts` | Punto de suelta: retiene ficheros de secreto y borra el valor literal antes del ACK |
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

## Ficheros en el borde de delegación

`messages[].artifacts` transporta ficheros de un agente a otro con la misma forma que
`output.artifacts` (`name`, `uri`, y opcionalmente `media_type` y `sha256`).

Topes propios, **todos** derivados de `@cauce/protocol`: una cifra escrita a mano sería un segundo
tope que se queda atrás y termina admitiendo lo que el puente rechaza.

| Tope | Valor | Por qué |
|---|---|---|
| Artifacts por mensaje delegado | 4 (`MAX_ATTACHMENTS_PER_MESSAGE`) | el mismo cupo que admite el sobre de adjuntos |
| Artifacts por turno | 8 (`MAX_RELAY_ARTIFACTS_TOTAL`, dos sobres) | un abanico de delegaciones no puede multiplicar el cupo del puente |
| Bytes agregados por turno | 10 MB (`MAX_ATTACHMENTS_TOTAL_BYTES`) | el mismo techo agregado del sobre |

Ese es el presupuesto del **parseo**, y lo gastan sólo los `messages[].artifacts`:
`output.artifacts` no lo toca. Vive además **fuera** de la contabilidad de texto: los topes de
64 KiB por `body` y 256 KiB agregados no se mueven porque un mensaje cuelgue 10 MB. Un artifact mal
formado —nombre inseguro, `uri` vacía o desmesurada, `media_type` inválido, `sha256` que no es
hexadecimal de 64— **se descarta y se anota por índice de mensaje**; nunca tira, porque ningún campo
accesorio puede costar el turno entero.

`artifact-inliner.ts` recorre `output.artifacts` **y** los `artifacts` de cada mensaje delegado con
**un único presupuesto de 10 MB compartido entre ambos** y un tope de 16 aperturas por turno, así
que la revisión de seguridad del inliner no está duplicada: `O_NOFOLLOW` y `O_NONBLOCK`, sólo rutas
absolutas, ningún segmento `..` (ni crudo ni percent-encodeado), nada bajo `/proc`, `/sys` ni
`/dev`, `fstat` sobre el descriptor ya abierto, tamaño comprobado dos veces, `sha256` declarado que
debe coincidir con lo leído, y tipo declarado por el agente o deducido de la extensión. Lo que no se
puede leer viaja tal cual; lo que no entra en el presupuesto se degrada a `cauce:not-sent` en vez
de anunciar un adjunto que el puente va a tirar sin decirlo.

Del lado durable, el salto de ida lleva los bytes como `attachments_v1`; el de vuelta y el fan-in
llevan **sólo referencias**, o una rama que contestó con 10 MB se multiplicaría cadena arriba. Una
referencia declara `sha256` únicamente cuando el store hasheó los bytes él mismo; si sólo tiene la
palabra del agente viaja como `declared_sha256`, para que nadie lea como verificado un digest que
no comprobó nadie.

**Una referencia tiene tope de referencia**, no de adjunto: `MAX_ARTIFACT_LOCATOR_CHARACTERS`
(2 048 caracteres, `@cauce/protocol`), y el salto de vuelta y el fan-in gastan además el mismo
acumulador agregado que el sobre —cupo por mensaje por tope de localizador—. Medir una `uri` contra
el presupuesto de bytes de un adjunto dejaba volver a entrar por la puerta de las referencias un
localizador de megabytes justo después de haber recortado el texto. Los `artifacts` de salida del
turno se acotan igual: el array al cupo de dos sobres, cada `uri` a su tope y el turno entero a un
presupuesto de caracteres; lo que se pasa se **degrada a `cauce:not-sent`** en vez de contarse
contra el agregado de salida, porque contarlo ahí convertiría un solo fichero legítimo en un turno
inválido entero.

En un `@all` los ficheros se repiten una vez por destino vivo. Si el texto solo cabe en el tope de
expansión pero el texto más los ficheros no, se **retienen los ficheros** —con su recuento y una
nota— y el texto llega a todos; rechazar la difusión entera por los adjuntos sería perder también
la pregunta. Cada descarte se cuenta por causa (cupo, bytes, difusión, ilegible, origen, nombre) y
la nota las nombra; un nombre rechazado deja además `rejected_attachment_names` en la auditoría,
que es un recuento y nunca el nombre. Ese presupuesto cuenta lo que se **guarda** —los caracteres
del base64—, nunca los bytes decodificados: contar los bytes decodificados admitía cuatro tercios
de lo que la difusión declaraba.

### Una respuesta que es sólo un fichero

Un turno cuyo único producto es un fichero cierra en `done` con una respuesta corta y honesta, no
en `failed` con una disculpa inventada:

- `reply: ""` (o sólo caracteres invisibles) con un artifact entregable ya no levanta
  `INVISIBLE_REPLY`: se sustituye por una línea fija que dice que el texto va en el fichero.
- `reply: null` sin delegaciones y con un artifact entregable cierra en `done` con esa misma línea,
  en vez de degradarse a `failed`.

**Entregable son sólo `data:` y `https:`**, y quien lo decide es el predicado de `@cauce/protocol`,
no una prueba de prefijo: `data:x` o `https:not-a-url` llevan un esquema entregable y ningún fichero
dentro, y con eso un turno mudo se estaba comprando un `done`. Un `file:` es una ruta de la máquina
del agente que lo escribió y no significa nada del otro lado; un `http:` el puente lo lista como
enlace a propósito, para no convertirse en un SSRF contra producción. Ninguno salva un turno mudo.

La decisión se toma dos veces, porque el contrato elige `done` **antes** de que el inliner gaste el
presupuesto agregado. Si al final no sobrevive nada entregable, el anuncio se retira: el turno pasa
a `failed` no reintentable con una respuesta que dice que el fichero no viajó y por qué. La
excepción es un turno que además delegó: ahí sólo se corrige la respuesta, porque un `failed` con
`messages` vivos es justo lo que el contrato prohíbe.

## Lo que el turno escribe en disco

Los adjuntos recibidos y las credenciales traspasadas viven en **dos** directorios `0700`
separados —ver «Credenciales selladas»— y los dos **sobreviven a la invocación del arnés**: se
liberan recién después de armar la respuesta, inlinear los artifacts y publicar el ACK. Borrarlos
antes es lo que impedía que un agente devolviera el mismo fichero que acababa de recibir, porque sus
`artifacts` se inlinean desde esas mismas rutas. Un `rm` que falla es un problema de disco, no de la
persona: se registra como `attachment_cleanup_failed` y se traga, porque convertirlo en fallo de
entrega repetiría un turno que el agente ya contestó.

`CAUCE_AGENT_WORKSPACE` decide dónde vive el directorio de **adjuntos** y es además el `cwd` del
arnés. Se exige ruta absoluta y directorio existente; si falta, no es absoluta o no es un
directorio, el directorio de la entrega cae al temporal del sistema y el arnés corre sin `cwd`
declarado. El de secretos no depende de esa variable nunca: siempre cuelga del temporal.

## Credenciales selladas

El bloque `secrets` del contexto de entrega enumera los traspasos dirigidos a este alias: **id,
etiqueta y ruta**. El valor existe como **un fichero `0600` mientras dura el turno**, y el buffer
que lo sostuvo se pone a cero en todas las salidas. Queda **una** copia que no se puede borrar: la
que el punto de suelta necesita para sustituir el valor literal. Una cadena de JS es inmutable, así
que vive hasta que la recoja el GC; no entra en el descriptor del turno ni en el prompt, y decirlo
es preferible a prometer un cero que no ocurre.

**Directorio propio.** Los secretos no comparten directorio con los adjuntos: `0700` bajo el
temporal del sistema, nunca bajo `CAUCE_AGENT_WORKSPACE`, que es el `cwd` del agente —ahí un
`git add`, un indexador o un `grep` suyos encontrarían el claro que dejó un SIGKILL. Un prefijo
entero sólo se puede denegar cuando ningún adjunto legítimo puede vivir debajo.

### Qué impide mecánicamente que el valor salga

El arnés recibe la **ruta** en su prompt, y el inliner desreferencia cualquier ruta absoluta que un
agente devuelva. Una frase del prompt no es un control, así que el punto de suelta
(`engine/secret-guard.ts`) envuelve al inliner y es mecánico:

- **Antes de leer nada**, todo artifact cuya ruta resuelva dentro del directorio de secretos —o a la
  ruta de un secreto— se retiene: no se abre siquiera, y conserva su identidad en el ACK con
  `uri: cauce:secret-withheld`, para que se vea qué se retuvo.
- Se retiene también el artifact **cuyos bytes tengan el sha256 de un secreto**, tanto si el inliner
  los leyó de una ruta como si el modelo escribió el `data:` él mismo: se decodifica el `data:`
  (base64 o percent-encoding) y se hashea. Eso cubre la copia byte a byte en cualquier otra ruta y
  el `data:` armado a mano, que antes no lo veía nadie.
- El **valor literal**, si aparece tal cual en la respuesta, en un cuerpo delegado, en un `notify` o
  en cualquiera de los **tres campos de texto libre** de un artifact (`name`, `uri` y `media_type`),
  se sustituye por la marca de redacción compartida de `@cauce/protocol`.
- **Nada de esto vuelve a leer el fichero del secreto.** La huella y el valor se capturan al
  materializarlo, con el claro en la mano, y viven en material de saneo que no entra ni en el
  descriptor del turno ni en el prompt. Releerlo al armar el ACK le habría dado al agente un desarme
  de un solo comando sobre un fichero que es suyo: un `rm`, un `chmod 0644` o una copia dejaban
  vacías las huellas y los valores, y las dos comprobaciones se volvían inertes sin decirlo.
- Nada de esto puede costar el turno: se anota `secret_artifact_withheld` con el recuento y el sobre
  sale igual. Si retener el único fichero deja un turno que dice «te dejo el fichero» sin nada
  adjunto, la respuesta se corrige después de la retención, no antes.

### Qué sigue siendo sólo una promesa del prompt

El bloque de contexto **pide** al modelo que no repita el valor. Eso es una instrucción, no un
control, y conviene decirlo entero: la sustitución literal atrapa el valor exacto y la huella atrapa
los bytes exactos, y ninguna de las dos atrapa el mismo secreto reescrito, partido en trozos,
recodificado o descrito de otro modo. Si el modelo lo transforma antes de escribirlo, llega a
`messages.body`, y de ahí a `dead_letters`, a la consola y
al volcado off-site append-only, que es un camino de ida. La redacción de publicación del gateway
(`CAUCE_REDACT_PUBLISH`) mitiga en parte: reconoce familias conocidas —claves privadas, credenciales
en URI, `Authorization`, JWT, claves de API de los proveedores habituales— y una contraseña de base
de datos o un token a medida no encajan en ninguna.

La afirmación que sí se sostiene es la estrecha: **Cauce nunca escribe el valor fuera de ese fichero
`0600`.**

### Cómo llega

El cuerpo de la entrega trae `secrets_v1`, una lista de referencias (`id`, `from_tenant`,
`from_alias`, `label`, `expires_at`) con tope de 8 por entrega. El adaptador **reclama** el sobre
sellado al gateway con `POST /v3/secrets/:id/claim` —nunca un `GET`, porque la lectura destruye lo
que devuelve—, lo abre con la mitad privada que guarda en `CAUCE_SEALING_KEY_PATH` (fichero `0600`,
generado en el propio contenedor la primera vez) y escribe el claro.

El *binding* criptográfico se reconstruye desde la **referencia que trajo la entrega** y desde la
identidad propia del adaptador, nunca desde el sobre recibido: quien pudiera contestar el transporte
elegiría si no el AAD que abre su propio blob. En concreto, el `key_id` del AAD es el que el
adaptador deriva de su propia clave pública, y el `sealing_key_id` que declara el sobre **se compara
contra él**; el `id`, el emisor y el destinatario del sobre se comparan contra la referencia y
contra la identidad local. Cualquier discrepancia cierra la puerta.

Un traspaso que no se puede abrir —sin transporte cableado, sin clave, caducado, sellado contra otra
llave, o con un sobre que no concuerda con su referencia— **se salta**, se anota como
`secret_handoff_skipped` con un código de razón por comprobación, y no cuesta el turno. Hoy ningún
binario de `src/bin/` cablea el transporte, así que la mitad receptora está en el SDK pero no en un
adaptador en marcha.

Decisión de diseño, alternativas descartadas y esquema durable: [ADR-007](adr/007-traspaso-sellado-de-secretos.md).

## La cadena: supervisor → runtime → harness

- **Supervisor** (`ops/scripts/container-adapter-supervisor.sh`): invocado por la unidad systemd del alias; resuelve config/bundle/PKI, valida el bind del contenedor, ejecuta con lock.
- **Runtime** (`ops/container-runtime/cauce-container-runtime.py`): corre dentro del contenedor;
  gestiona metadatos de generación/PID, elimina metadatos obsoletos solo tras probar quiescencia y
  falla cerrado ante cualquier identidad ambigua.
- **Harness**: el binario SDK que conecta al bus y ejecuta deliveries.

## Inyección de contexto

- **Contexto nativo de perfil** (`context/native-profile-context.ts`): inyecta `CLAUDE.md`/`AGENTS.md`/etc. como archivos de contexto nativos del harness (actualmente OFF — de los seis puntos de [roadmap.md](roadmap.md) §1 quedan dos sin verificar).
- **Contexto fijo** (`harnesses/contexto-fijo.ts`): contexto estático por tipo de harness.

### Siembra no fatal

Al recibir `hello_ack`, `sdk/client.ts` siembra el perfil del agente en los ficheros del arnés. **Esa siembra no puede costar la conexión**, y esa decisión es deliberada.

Antes lanzaba un `PROFILE_SEED_FAILED` reintentable, que cerraba la conexión antes de reclamar una sola entrega. El problema es que hay fallos de siembra que el adaptador **no puede resolver por sí mismo**: el caso común es una revisión de perfil subida desde la consola que todavía no se aplicó al disco. La guarda de `siembra-del-perfil.ts` se niega entonces a escribir («sólo el publicador durable puede cambiarla»), y el adaptador reintentaba contra un desajuste que sólo un operador humano podía deshacer.

Medido en producción el 01-09-2026 sobre el alias `zeus`: **1.074 reconexiones en 8 h 52 min**, todas muriendo en el mismo punto, con cada mensaje dirigido a ese alias caducando en la cola. El dueño no se enteró porque el bus le acusaba recibo igualmente.

El intercambio elegido: correr con un perfil desactualizado es un problema de *contenido*; quedarse sordo **y callado** es peor. Por eso el fallo ahora es ruidoso en tres sitios —línea de log, `onError('PROFILE_SEED_FAILED')` para las superficies del operador, y un evento `connection_degraded`— y el alias sigue consumiendo con el perfil anterior.

Una proyección **revisionada** (con marcador `CAUCE:REVISION-PERFIL`) cuyo texto difiere del que el adaptador generaría no es un fallo: la escribió el publicador durable y sólo él puede cambiarla, así que la siembra la deja intacta con estado `delegado-al-publicador` y la conexión no se degrada. Degradarla no arreglaba nada (el adaptador nunca la va a reescribir) y marcaba a cada alias claude tras cada recarga, porque el bloque lleva cuotas vivas que cambian entre la recarga y el siguiente hello.

Dos detalles que sostienen esto:

- `hello_ack` cancela su plazo y siembra el lease inicial, pero no demuestra por sí solo una conexión
  estable ni reinicia el backoff. Este se reinicia al recibir un `heartbeat_ack` con lease creciente
  o al acreditar tráfico real enviando el outbox; un fallo de siembra sigue sin cerrar la conexión.
- `resumenDeLaSiembra` incluye el **motivo** de cada fichero que no se pudo escribir, no sólo el recuento. El recuento a secas (`no-se-pudo-escribir=1`) se registró más de mil veces durante el apagón sin decir nunca cuál de las dos ramas de fallo se había disparado.

### El presupuesto del fichero anfitrión

`ficherosDelArnes` no acota sólo lo que Cauce escribe —eso ya lo acota `AGENT_PROFILE_LIMITS.total`
(24.000 unidades)— sino el **fichero entero**, bloque gestionado más manual del anfitrión. La tabla
única de presupuestos vive en `packages/protocol/src/ficheros-del-arnes.ts`
(`PRESUPUESTOS_DE_CONTEXTO`) y cada entrada **declara su unidad**: openclaw cuenta unidades UTF-16
y codex cuenta **bytes UTF-8**. Confundirlas se equivoca hasta 4× en un manual acentuado, así que
el mensaje de error nombra siempre la unidad que usó.

Para codex el número por defecto es 32 KiB, y **el hecho medido por alias siempre lo sobrescribe**:
es el `project_doc_max_bytes` del `config.toml` de ese contenedor. Las tres rutas de producción lo
leen y se lo pasan a `ficherosDelArnes` como `topes`:

| ruta | de dónde sale el hecho |
|---|---|
| siembra del adaptador (`context/siembra-del-perfil.ts`) | lee el `config.toml` del directorio del arnés con el mismo `DiscoDelArnes` que escribe |
| PUT del runtime (`console/agent-profile-runtime.ts`) | `RuntimeFacts.projectDocMaxBytes` de la presencia medida |
| vista previa de la consola (`console/agent-profile.routes.ts`) | el presupuesto y los bytes de disco que devuelve el propio preflight |

La vista previa compone contra los **bytes medidos** del contenedor, no contra un fichero vacío
imaginado, y aplica el mismo presupuesto que la siembra. Si el perfil no entra, el GET **sigue
contestando 200 con el perfil** —el editor es la única pantalla que puede recortarlo— y deja los
ficheros vacíos con el motivo en `runtime_verification` (estado `unverified`, y una razón que
nombra el fichero, los dos números, la unidad y si el tope es el medido o el de defecto). El PUT
sí se niega, con 422 y esos mismos números, **antes** del CAS durable: nunca se escribe media
persona. Cuando no hay hecho medido rige el defecto, y el motivo lo dice con esas palabras
(«tope por defecto del arnés» frente a «tope medido del alias»).

El hecho medido lo produce el pty-agent con `tomllib`; la siembra, que corre dentro del
contenedor y no puede esperar al pty-agent, mantiene su propio lector del `config.toml`. Ese
lector recorre **sólo la tabla raíz** —para en la primera cabecera `[x]`/`[[x]]`— y acepta el
entero en cualquiera de las formas que acepta `tomllib` (decimal con guiones bajos, `+`, `0x`,
`0o`, `0b`, con comentario al final). Ante cualquier línea de la raíz que no sepa clasificar
—cadenas multilínea, arrays, tablas en línea, claves con punto, comillas sin cerrar, una clave
repetida— **aborta a `undefined`** y rige el defecto: puede fallar cerrado (presupuesto más
pequeño, no se escribe nada), nunca abierto. El corpus de
`tope-de-codex-paridad-tomllib.test.ts` pasa las mismas muestras por los dos lectores y falla en
cuanto el escáner lee un tope que `tomllib` no.

## Tests

La suite usa `node:test`. Ejecutar:

```bash
pnpm --filter @cauce/adapter-sdk test
```

`CAUCE_TEST_TIME_SCALE` (leída en `test/client-fixtures.ts`) multiplica **sólo los plazos que
fija la propia prueba**: los del fixture (deadline del claim, timeout del arnés, lease), los
watchdogs que cada caso configura y la espera de sus condiciones. No toca los tiempos del código
de producción, ni los timeouts de `node:test`, ni ningún reintento real. Sirve para correr la suite en una máquina cargada —donde un plazo de 5 s se agota por
falta de CPU y no por un fallo— sin tocar el código: `CAUCE_TEST_TIME_SCALE=4 pnpm --filter
@cauce/adapter-sdk test`. **No enmascara un timeout de verdad**: si el arnés no arranca o el ACK
no llega, la prueba sigue fallando, sólo que más tarde; el valor por defecto es `1` y cualquier
valor no finito o no positivo cae a `1`.
