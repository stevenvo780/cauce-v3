# Sesión compartida: la TUI real y el bus, una sola conversación

**Pilotos:** `kratos` (harness **claude**, `ws-humanizar`) · `socrates` (harness **codex**, `ws-prizma`).
`argos` no se toca.

Lo que el dueño pidió, y que ahora se cumple entero:

1. `cauce <alias>` abre **el binario real** del harness — su panel, sus `/comandos`, su historial.
   No es un cliente de línea que imita una TUI.
2. Lo que llega por Telegram entra por **esa misma conversación**, y se ve **en vivo** en el panel.
3. El bus sigue recibiendo el **sobre estructurado** íntegro. El contrato no se relajó ni un byte.

---

## Cada harness usa un mecanismo distinto, y eso es correcto

|  | claude (`kratos`) | codex (`socrates`) |
|---|---|---|
| Mecanismo | tmux + cosecha del transcript | app-server de primera parte |
| Cómo entra el turno del bus | pegado entre corchetes en la caja de entrada | `turn/start` por WebSocket |
| De dónde sale el sobre | del `.jsonl`, **nunca** de la pantalla | campo tipado `agentMessage` |
| Arbitraje necesario | sí: hay UNA caja de entrada | no: el bus no escribe en la caja |

La asimetría no es un descuido: **codex tiene demonio local y claude no**. En claude,
`--input-format stream-json` sólo funciona con `--print` (headless, sin TUI), `--tmux` es para
worktrees y `--remote-control` es la nube de Anthropic. No existe ningún proceso local capaz de
meter un turno en una TUI viva, así que se conduce por teclas.

---

## Por qué NO se eligió "turnos sobre la misma sesión"

Era la salida favorita del enunciado y está **descartada por medición**. El turno del bus por
`--print --resume` sí corre con la TUI viva y sí hereda su contexto, pero **la TUI no ve nunca el
turno del bus** — ni al turno siguiente. En el DAG del transcript los dos cuelgan del mismo padre:

```
37  user  1c8baf8b  parent f6e4aff8   <- turno del BUS
49  user  ad72e337  parent f6e4aff8   <- siguiente turno de la TUI
```

La TUI encadena desde su cabeza en memoria, así que cada turno del bus queda en una **rama hermana
que ignora para siempre**. Contexto de una sola dirección: el agente lo sabe todo y el panel del
dueño es ciego. Es la tercera vez que algo «parece» compartido sin estarlo.

`test/shared-session.test.ts` fija esa regresión: hay una prueba que planta una respuesta válida en
una rama hermana y exige que **no** se coseche.

## Por qué NO se raspa la pantalla

- Un sobre largo **no se recupera**: el wrapping parte el JSON.
- `capture-pane -S -2000` devuelve lo mismo que sin `-S`: claude vive en pantalla alterna
  (`history_size=0`) y lo que sube del viewport se pierde.
- El eco del pedido contiene **otra copia** del JSON, así que un raspador no distingue la pregunta
  de la respuesta.

La pantalla se lee para **una sola cosa**: saber si el dueño tiene algo a medio escribir
(`src/shared-session/pane.ts`). Si esa heurística se equivoca, en el peor caso se espera de más o se
pisa una línea — nunca se corrompe un resultado.

---

## Cómo funciona, en claude

1. **Preflight.** Se asegura la sesión `cauce-<alias>` en el socket tmux `cauce`, con la TUI en la
   ventana `agente`, lanzada con `bash -lc` para que herede el mismo entorno que cuando el dueño la
   abre a mano.
2. **Arbitraje.** Se captura el panel y se espera a que la caja de entrada esté vacía. Con una línea
   a medio escribir, inyectar dejaba
   `❯ estoy escribiendo algo a mediasMENSAJE DEL BUS…`. Nunca se escribe encima.
3. **Inyección.** `tmux load-buffer -` + `paste-buffer -p`: pegado entre corchetes, de modo que las
   ~30 líneas del prompt entran como **una sola entrada** y no como 30 envíos. Luego un `Enter`.
4. **Cosecha.** Se busca en el `.jsonl` la entrada `user` cuyo `message.content` es **exactamente** lo
   pegado (medido: el pegado se guarda verbatim como string, con `promptSource:"typed"`), y después
   la respuesta `assistant` con `stop_reason:"end_turn"`, `isSidechain:false` y **descendencia real**
   de esa entrada.
5. **Desenvoltura.** Si el texto viene envuelto en un vallado ```` ```json ```` que abarca todo, se
   quita. En `--print` el modelo devuelve JSON pelado; dentro de la TUI lo valla. Eso es transporte,
   no contrato: el sobre se sigue exigiendo y validando entero.

**Desde el `Enter` no se degrada nunca.** El turno ya está corriendo y pudo haber ejecutado
herramientas; reejecutar por el camino de siempre aplicaría los efectos dos veces. Un fallo a partir
de ahí es **ambiguo** y se dice como tal (`EXECUTION_TIMEOUT_AMBIGUOUS` / `PROCESS_EXIT_AMBIGUOUS`).

## Cómo funciona, en codex

`codex app-server --listen unix://…` en la ventana `servidor` y `codex --remote unix://…` en la
ventana `agente`. El adaptador entra como **segundo cliente** del mismo app-server:

```
initialize               -> ok
thread/loaded/list       -> ["019fb4a9-…"]      el hilo VIVO de la TUI
thread/resume {threadId} -> ok   <- esto es lo que SUSCRIBE; sin esto no llega ninguna notificación
turn/start {threadId,…}  -> turn inProgress
```

El socket habla **WebSocket**, no JSON crudo: sin handshake el servidor responde
`failed to upgrade control socket websocket connection`.

### La trampa que casi se lleva por delante todo el camino de codex

`ws` ofrece **permessage-deflate** por defecto, y con esa extensión ofrecida el app-server **aborta
el upgrade**: el cliente ve un `socket hang up` seco y el servidor no registra nada. Medido el
2026-07-30 contra `codex-cli 0.144.6`, con el `ws@8.21.1` que va en el bundle:

| Opciones del cliente | Resultado |
|---|---|
| por defecto | `ERR socket hang up` |
| `headers: {Host: localhost}` | `ERR socket hang up` |
| **`perMessageDeflate: false`** | **`INITIALIZE_OK`** |
| `Host` + `perMessageDeflate: false` | `INITIALIZE_OK` |

Un handshake escrito a mano sin extensiones responde `101 Switching Protocols` en cualquier ruta
(`/`, `/ws`, `/v1`, vacía), lo que confirma que el problema es la extensión y no el servidor.

Importa porque el fallo es **total y silencioso**: sin esto la sesión compartida de codex habría
degradado en el 100 % de los turnos. Se habría avisado —el mecanismo de aviso funciona— pero nunca
habría compartido nada.

El `Host` explícito se deja igual: para una URL `ws+unix://` el host que deduce `ws` es la ruta del
socket, que contiene `/` y no es un token HTTP válido. Este servidor lo tolera; otro no tendría por
qué.

Verificado también que el socket **tiene que vivir bajo `$HOME`**: en `/tmp` el app-server muere con
`Operation not permitted (os error 1)`.

`daemon start` no sirve acá — exige el *managed standalone install* en
`$CODEX_HOME/packages/standalone/current/codex`, que no existe porque el binario es un paquete npm
global— pero `--listen unix://` arranca igual.

El sobre llega como campo tipado (`agentMessage`, `phase:"final_answer"`) y el pedido como un tipo
**distinto** (`userMessage`), así que la ambigüedad del eco no existe.

---

## El aviso de caída, que es la mitad del trabajo

El intento anterior no falló por no funcionar: falló porque **cuando no funcionaba, nadie se
enteraba**. Su log decía `bus_client_connected` → `client_gone` sin turno mientras el adaptador
contestaba por su vía de siempre en 15-18 s.

Acá una caída se ve en **cuatro** sitios:

| Superficie | Qué se ve |
|---|---|
| El "reply" que llega por Telegram | `⚠ CAUCE — SESIÓN COMPARTIDA CAÍDA` + motivo + cómo restablecerlo |
| El panel del dueño | mensaje inmediato en la barra + la barra de estado **en rojo** |
| `cauce <alias>` | lista los avisos pendientes **antes** de enganchar |
| El journal del adaptador | `{"event":"shared_session_degraded",…}` |

> La ventana **no** se renombra. Antes se renombraba a `⚠ CAUCE-DEGRADADO` y eso se auto-enclavaba:
> el adaptador busca la ventana por su nombre (`cauce-<alias>:agente`), así que en cuanto salía el
> primer aviso dejaba de encontrarla y **todas** las entregas siguientes degradaban `tui_absent` en
> 0,2 s, para siempre, con la TUI viva delante y diciendo la mentira «la sesión existe pero no tiene
> panel de TUI». Una sesión que haya quedado así con el build viejo se repara sola en el siguiente
> turno: se le devuelve el nombre.

El aviso lo escribe **el adaptador, después de validar el sobre**, nunca el modelo. Ya se demostró
que un agente puede falsificar cualquier señal que venga de su stdout (un descendiente que hereda el
pipe envuelve la salida), así que un aviso autodeclarado no probaría nada. Y va después de
`validateDeliveryOutput` para que no pueda volver válido un sobre que no lo era.

Motivos posibles:

| `reason` | Qué pasó | ¿Cayó al camino de siempre? |
|---|---|---|
| `session_absent` | no hay sesión tmux y no se pudo crear | sí |
| `tui_absent` | la sesión existe pero no hay TUI viva / hilo cargado | sí |
| `input_busy` | el dueño dejó texto a medio escribir y no lo soltó | sí |
| `modal_blocking` | la TUI está esperando que el dueño conteste un diálogo | sí |
| `handshake_failed` | el mecanismo no respondió | sí |
| `context_reset` | la TUI se reinició sola y la conversación empezó de cero | **no** |
| `session_created` | no había terminal abierta: se creó una nueva y vacía | **no** |
| `context_cleared` | el dueño vació el contexto (`/clear`, `/new`) | **no** |
| `context_compacted` | la terminal compactó: lo anterior quedó resumido | **no** |

Los cuatro últimos **no** degradan: el turno **sí** pasa por la terminal, lo que cambió es la
memoria. Se avisan igual porque desde fuera «compartida y vacía» es indistinguible de «compartida y
completa». Van con marca propia (`⚠ CAUCE — LA TERMINAL SE REINICIÓ` los dos primeros,
`⚠ CAUCE — EL CONTEXTO DE LA TERMINAL CAMBIÓ` los otros dos) y llegan **también** al panel del
dueño, sin rojo: él es el único que puede compensar una compactación volviendo a pegar lo
importante.

Cómo se detecta cada uno, todo medido el 2026-07-30:

- `context_reset`: cambia el `pane_pid`. La causa medida es que `claude` se auto-actualiza y se
  relanza solo (visto `Auto-updating…` con la TUI reportando 2.1.179 y el binario en 2.1.220).
- `session_created`: `ensure` tuvo que crear la sesión. Antes se descartaba ese dato: con la sesión
  borrada, la entrega se respondía en 75,9 s con `exitCode 0` y **cero** avisos.
- `context_cleared`: en claude, el `.jsonl` activo cambia de `sessionId` **sin** que cambie el
  `pane_pid` —por eso el heurístico del PID no lo ve nunca—; en codex, `thread/loaded/list` empieza
  a devolver un hilo más. En codex hay un corolario obligatorio: se sigue el hilo **nuevo**.
  Quedarse en el viejo daba respuestas plausibles de una conversación que el dueño ya no mira.
- `context_compacted`: en claude, un `compact_boundary` nuevo en el transcript (con `trigger` y
  `preTokens`→`postTokens`); en codex, un item `contextCompaction` dentro del turno.

Una compactación además **corta la cadena de padres** del transcript (`parentUuid: null`, la
continuidad sólo en `logicalParentUuid`) y **reemite** el segmento preservado con los mismos uuid
recolgados del resumen. Sin tratar las dos cosas, una compactación a mitad del turno del bus hacía
que la respuesta no se cosechara **nunca**: una hora de presupuesto y `EXECUTION_TIMEOUT_AMBIGUOUS`
con el agente ya habiendo contestado. Eso no es contexto perdido, es **entrega** perdida, y es un
bug, no una política.

---

## Encender un alias

En `~/.config/cauce-v3/container-aliases/<alias>.env`:

```
SHARED_SESSION=1
SHARED_SESSION_WORKSPACE=/workspace
```

El supervisor sólo lo acepta para `claude` y `codex`, sólo con el valor exacto `1`, y exporta
`CAUCE_SHARED_SESSION`, `CAUCE_SHARED_SESSION_WORKSPACE` y un `TERM` utilizable. Sin el interruptor
el adaptador se comporta **byte a byte** como hoy.

Después:

```
ops/scripts/install-cauce-cli.sh     # instala el CLI del dueño desde el repo
ops/scripts/retire-session-host.sh   # retira el anfitrión anterior (una sola vez)
```

## Lo que se retira

`cauce-v3-session-host@.service`, su lanzador y el cliente de línea `ia-tui-session`. Resolvían el
mismo problema con un socket propio y una TUI imitada; con el binario real dentro de tmux no aportan
nada y sí restan, porque `cauce <alias>` tenía una rama que los prefería. Nada se borra: se mueven a
`~/.local/share/cauce-v3/retirado/` y el código sigue en `b9efb7d`.

## Lo que cuesta

- **El acoplamiento de claude es por teclas**, que no es una API estable: un rediseño de la caja de
  entrada lo rompe.
- **Una segunda terminal chica reflowea el panel para todos**: manda el cliente más pequeño
  (200x50 + 100x30 → 100x29 para los dos).
- **En codex el app-server es punto único de fallo** para las dos puertas, y los dos subcomandos
  están marcados `[experimental]`.
- **`/clear` y `/compact` del dueño** vacían el contexto que el bus creía compartir, y eso todavía no
  se detecta.

## Nota sobre el inventario

`ops/container-aliases.json` en este árbol dice que `kratos` es **codex**; en kratos la copia viva ya
dice **claude** (migrado el 2026-07-30). El inventario del host manda, y tocar el del repo movería el
digest de release y los 14 units generados sin necesidad. Se deja constancia y se decide aparte.
