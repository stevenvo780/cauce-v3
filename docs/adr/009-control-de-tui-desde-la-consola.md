# ADR-009: control de la TUI de un agente desde la consola

**Estado:** aceptada. El modo `harness_rw`, la tabla `terminal_control_holds` (migración `040`),
las rutas de toma/devolución/prórroga, la grabación del relay y el interruptor
`CAUCE_TERMINAL_RW_ENABLED` están en el árbol. El interruptor arranca **apagado** y
`deploy/compose.yaml` todavía no declara ninguna de las variables del modo: un despliegue tal cual
sigue comportándose exactamente como antes.

## Contexto

Hasta W3b la consola podía **mirar** la TUI de un alias y nada más. `harness` abre la sesión tmux
real del agente en modo visor (`tmux attach -r -f ignore-size`) y el agente PTY descarta su STDIN
antes de tocar el descriptor (`ops/pty-agent/README.md`, §«Los tres modos de sesión»). Para
teclear en la TUI de un alias había que entrar a kratos por SSH y usar `ops/guardias/cauce-attach`,
que es una herramienta de operador fuera de banda.

El pedido D3 del programa v3.1 es que el operador pueda **escribir** en esa misma TUI desde la
consola. Eso cambia la naturaleza de la superficie: una consola comprometida deja de poder observar
a un agente y pasa a poder actuar como él, con su identidad, dentro de su contenedor y sobre sus
ficheros. Y trae un conflicto que no existía: mientras un humano teclea en la TUI compartida, el
bus puede entregarle un turno al mismo agente y las dos escrituras se mezclan en el mismo panel.

Además hay dos exclusiones que **ya existen** en la flota y que resuelven problemas parecidos pero
no el mismo:

- **`ops/guardias/cauce-attach`** es exclusión a escala de operador y de unit: calla al adaptador
  entero para que el humano teclee, vive horas, y es precisamente la herramienta que tiene que
  funcionar con el bus roto.
- **`@cauce_input_barrier`** (`packages/adapter-sdk/src/shared-session/tmux/mutation.ts`) es lo
  contrario: excluye el teclado humano durante UNA pegada del adaptador y dura lo que dura esa
  pegada. Es un CAS local sobre una opción de panel de tmux.

## Decisión

**Un modo de sesión nuevo, un arriendo en Postgres, y la grabación como condición del modo.**

### 1. `harness_rw` es un modo, no un flag del permiso

`TerminalMode` pasa a ser `shell | harness | harness_rw`
(`services/gateway/src/terminal/types.ts`), y `WRITABLE_MODES` es `{shell, harness_rw}` en el
mismo fichero. La alternativa era dejar dos modos y añadir un `writable: true` al grant o al
cuerpo del pedido.

Se eligió el modo porque `mode` **ya entra en el material del `request_sha256`**
(`services/gateway/src/terminal/session-control.ts`, `terminalAdmissionRequestSha256`): el ticket
de admisión ya está firmado sobre el modo pedido, así que un modo nuevo queda cubierto por el
mismo digest sin superficie nueva. Un flag paralelo habría sido un campo más que firmar, un campo
más que revalidar en `/authz` cada 30 s y un camino más por el que una sesión de sólo lectura
pudiera convertirse en escribible sin volver a pasar por las seis compuertas de la apertura.

Consecuencia directa: `grants.json` no lleva ningún campo nuevo. Un permiso de escritura es una
fila que **nombra el modo** `harness_rw`, y `parseGrants`
(`services/gateway/src/terminal/authority.ts`) rechaza el fichero entero si una fila con
`operator: "*"` lleva un modo escribible.

### 2. El control vive en una tabla nueva, `terminal_control_holds`

La migración `040` (`packages/store/migrations/040_terminal_control_holds.sql`) crea la tabla y su
índice único parcial `(tenant_id, alias) WHERE released_at IS NULL`: **un arriendo vivo por alias**.
El API está en `packages/store/src/terminal-control-holds.ts`.

Se rechazó explícitamente unificar los tres mecanismos bajo un arriendo en red. `cauce-attach` y
`@cauce_input_barrier` resuelven problemas de escalas opuestas —horas contra milisegundos, unit
contra panel— y el segundo vive **en el camino caliente de pegado del adaptador**. Meter ahí un
`round-trip` a Postgres cambiaría un CAS local que falla cerrado por algo que, en una partición de
red, o bloquea todas las pegadas de la flota o admite dos escritores en el mismo panel. Esa es la
razón por la que TUI-03 quedó **REFUTADO**: no es que no se pueda unificar, es que unificarlo
empeora el mecanismo más rápido de los tres.

El arriendo de la consola queda entonces como una **tercera** exclusión, la única que necesita ser
visible para el bus, y es la única que se apoya en la base.

### 3. Las entregas se ENCOLAN, no se fallan

Mientras hay un arriendo vivo, `claimOne`
(`packages/store/src/repository/deliveries/claims.ts`) añade un `NOT EXISTS` sobre
`terminal_control_holds` a su predicado de selección. Eso es todo lo que hace: **no toca `status`,
no toca `available_at`, no toca `attempt`**. Las filas siguen `pending` con su orden intacto y se
toman en ese mismo orden en cuanto se suelta el control.

La alternativa —marcarlas `failed`, o reencolarlas con `available_at` en el futuro— convertiría
«un humano tecleó durante diez minutos» en «este agente perdió un turno», que es un daño real por
una condición transitoria y esperada.

Una entrega **ya arrendada** antes de la toma no se toca: el arriendo cierra la puerta a leases
NUEVOS, nunca a los que están en vuelo. Un turno a medias se termina.

### 4. El motivo lo escribe una persona

`operatorReason` (`services/gateway/src/terminal/plugin.ts`) exige entre 8 y 280 caracteres y no
tiene valor por defecto: **nunca se genera**. La consola lo pide en un `textarea` y no ofrece
plantilla (`console/src/features/terminal/ControlDeTui.tsx`).

La razón es que el motivo es la única explicación humana que la fila de auditoría va a llevar
jamás. La grabación dice qué se tecleó; los contadores dicen cuánto; nada dice **por qué** salvo
esa frase. Un motivo autogenerado la volvería ruido y dejaría la fila sin la única parte que un
lector futuro no puede reconstruir.

La devolución es lo contrario y por eso admite motivo opcional: `beforeunload` no tiene a nadie a
quien pedirle que escriba, así que una devolución sin motivo lleva `operator_released`
(`services/gateway/src/terminal/session-control/control.ts`) y la fila sigue diciendo quién
devolvió el alias. Un arriendo que sobrevive a la pestaña es lo que calla a un agente.

### 5. Una fila de auditoría agregada, no una por ráfaga de teclas

Ésta es una **desviación consciente de D3**, que pedía registro por ráfaga.

El relay coalesce la entrada cada 8 ms y **no tiene `DATABASE_URL`** —está sólo en la red `edge`
por construcción (`docs/terminal-pty.md`, §3, kill switch 2)—, así que una fila por ráfaga
significaría o un viaje al gateway por cada pulsación o un canal de escritura a la base desde el
proceso que lleva los bytes del PTY. Las dos cosas son peores que el problema.

El registro por ráfaga existe, pero vive en la **grabación** del relay
(`services/terminal-relay/src/recording.ts`): un asciicast v2 con un evento `i` por ráfaga y su
marca de tiempo. Lo que llega a Postgres es una fila agregada al cierre, con `bytes_in`,
`input_batches` y la `sha256` de la grabación, más `recording_capped` cuando el fichero se truncó.
La fila dice cuánto y remite al fichero; el fichero dice qué.

### 6. La grabación es condición del modo

`recordingRequirement` (`services/terminal-relay/src/session-limits.ts`) devuelve `required` para
`harness_rw`. Sin un `CAUCE_TERMINAL_RECORDING_DIR` escribible la apertura se **rechaza** con
`recording_unavailable` (`1011`) antes de que exista el PTY, y un fallo de escritura a mitad de
sesión la cierra con `recording_failed`
(`services/terminal-relay/src/session-instance.ts`). No hay modo degradado.

Se decidió así porque la grabación es la única copia durable de lo que se tecleó: si fuese un
extra, el modo escribible funcionaría igual sin ella y la primera vez que hiciera falta reconstruir
qué pasó no habría nada. Un modo que nadie puede reproducir después no es un modo auditado, es un
modo con una fila de auditoría que no acredita nada.

Una sesión de sólo lectura **nunca** se graba —no tiene teclado que grabar— y un `shell` normal
sólo detrás de `CAUCE_TERMINAL_RECORD_SHELL_SESSIONS`, apagado por defecto: las pulsaciones de un
shell de operador (una contraseña de `psql`, un token pegado) no se persisten salvo que el dueño
lo pida.

### 7. Interruptor propio, apagado por defecto

`CAUCE_TERMINAL_RW_ENABLED` (`services/gateway/src/terminal/config.ts`) es `writableTuiEnabled` y
sólo vale `'1'`. Cerrado, `POST /sessions` con `harness_rw` responde `403 writable_tui_disabled`
**antes de leer la tabla de flota**, y la toma de control responde lo mismo.

Es un interruptor separado de los tres del runbook porque apaga **la escritura, no el canal**:
`harness` y `shell` siguen funcionando. Arranca apagado porque el modo amplía lo que una consola
comprometida puede hacer, de mirar a teclear, y un valor por defecto encendido convertiría cada
despliegue del gateway en una decisión de seguridad que nadie tomó a propósito.

## Consecuencias

- El techo de un arriendo es un `CHECK` de la base (`taken_at + interval '12 hours'`), no la
  palabra del proceso que extiende. Además, `takeControlHold` calcula el vencimiento como
  `LEAST(ventana de la sesión, ventana del arriendo)` **en SQL**, leyendo la sesión bajo
  `FOR UPDATE`: un arriendo no puede sobrevivir a la sesión que lo abrió.
- Un navegador que muere sin devolver no calla a un alias indefinidamente: la toma siguiente de ese
  alias suelta como `expired` los arriendos vencidos antes de insertar el suyo, y el cierre o la
  revocación de la sesión sueltan el arriendo **dentro de la misma transacción** que liquida la
  sesión (`releaseHeldControl`). La caducidad es la red, no el mecanismo.
- El relay se entera por el mismo ciclo de `/authz` de 30 s que ya revalida todo lo demás: el
  gateway contesta `403` con `reason: "control_released"` y sólo entonces
  (`services/gateway/src/terminal/relay-proxy/authorization.ts`), y el relay cierra con
  `4410 control_released` (`services/terminal-relay/src/session-limits.ts`).
- La consola gana una superficie de escritura, y con ella la obligación de devolver: `ControlDeTui`
  devuelve el arriendo al desmontarse y en `beforeunload`, y el aviso de que el bus deja de
  entregarle al alias está en pantalla **antes** de que el operador escriba el motivo.
- `/metrics` del relay gana `cauce_terminal_control_sessions_open` y
  `cauce_terminal_recordings_total{result}`. Como todas las series del relay, son agregadas: no hay
  etiqueta de tenant, alias, operador ni sesión, porque la forma de a quién se está vigilando no
  puede filtrarse a un blanco de scrape que no tiene autorización propia.

## Fuera de alcance, dicho explícitamente

- **La retención de las grabaciones.** Nada poda el directorio. Cuánto se guarda un `.cast`, en qué
  volumen y quién lo borra es una decisión del dueño y **no está tomada**. Mientras no lo esté, el
  directorio acumula material sensible con el mismo perfil de amenaza que el propio flujo del PTY
  (`0700` el directorio, `0600` los ficheros, abiertos con `O_EXCL`).
- **La otra puerta a la misma shell.** El worker legado de ultimate-terminal sigue vivo en 9 de los
  11 contenedores y tiene su propio modelo de autorización: vaciar `grants.json` no lo cierra.
  Sigue siendo la deuda con fecha del §5 de `docs/terminal-pty.md`.
- **El cableado en `deploy/`.** Ninguna de las tres variables del modo está declarada en
  `deploy/compose.yaml`. Encenderlo exige tocar ese árbol, que es del dueño.
