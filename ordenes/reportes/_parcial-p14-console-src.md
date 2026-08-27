# Parcial p14 · Comentarios borrables del sector código fuente de `apps/console/src` y `packages/adapter-sdk/src`

Lote exclusivo: 40 ficheros del censo (38 de `apps/console/src` + `packages/adapter-sdk/src` y 2 de `ops/`). Verificado el estado ACTUAL línea por línea; cifras del censo ya no aplican — tras los commits `901411f`, `802d323`, `6f7720a` y los `refactor(console): descomposicion ...` que rompieron `api/types.ts`, `mocks/data.ts`, `harnesses/shared.ts`, `shared-session/tmux.ts` y `shared-session/paste-runner.ts` en barrel files, la mayoría del sector está en 0 ó casi 0. Los pocos que quedan tienen borrables de tipo narrativo puntual, casi todos compactables a una línea de invariante, y tres mutilados reales (commits 2a22107) que otra instancia puede retirar por línea.

## Tabla por fichero

`apps/console/src/features/live/agent-state.ts:294-295` · narrativo · «Si» (JSDoc residual que duplica la regla del return de `liveState`) — ` · [compactar: conservar línea N]` · [cierra-bloque]

`apps/console/src/features/live/agent-state.ts:347-347` · ceremonial · «Re-export» (el `export {` ya dice qué hace) — una línea, ya marcado en el lint.

`apps/console/src/features/live/LiveFleetPage.tsx:68-68` · ceremonial · «Estado» (divisor de sección)
`apps/console/src/features/live/LiveFleetPage.tsx:115-115` · ceremonial · «Acotamiento» (divisor de sección)

`apps/console/src/api/types.ts:1-10` · 0 líneas (ya limpiado) — todo el censo era del monolito `types.ts` que se descompuso a `types/*.ts` en commit `6d52dde`; este fichero ahora sólo re-exporta, no tiene nada borrable.

`apps/console/src/features/config/collection-table.ts:118-119` · narrativo · «La» (explica la fusión citando el ejemplo «Steven → »; la regla de no-fundir-a-medias ya está implícita en `fundir`) — compactable.

`packages/adapter-sdk/src/harnesses/shared.ts:1-29` · 0 líneas (ya limpiado) — descompuesto a `harnesses/shared/*.ts`; este fichero es barrel.

`apps/console/src/mocks/data.ts:1-33` · 0 líneas (ya limpiado) — descompuesto a `mocks/fixtures/*.ts`; este fichero es barrel.

`apps/console/src/features/terminal/denegaciones.ts:33-35` · 0 líneas efectivas · la frase clave "El dueño del bus. No se escribe un nombre propio" sigue justificando la constante `DUENO_DEL_BUS`; ya compactado al máximo.

`apps/console/src/features/terminal/api.ts:1-6` · 0 líneas (ya limpiado) — JSDoc corto sobre CSRF/feature-scope.

`apps/console/src/features/live/directiva.ts:26-33` · narrativo · «Los» (cuenta "14 briefs de producción" como origen de la lista de regex; el censo lo marcaba "mixto" y la cifra es de un día concreto)

`apps/console/src/features/landing/landing.ts:108-114` · narrativo · ««Trabado»» (bloque JSDoc dentro del literal del objeto, que cuenta la historia del renombre «detenido» → «trabado» y del choque con `ack_stalled`; la regla del id inmutable está ya en `DirectivaTab` y la regla de vocabulario vive en otro sitio) — borrable entero.

`apps/console/src/features/topology/hypergraph-layout.ts:1-15` · 0 líneas (ya limpiado) — invariante puro sobre por qué hiperorafia y por qué determinismo; no es narrativo.

`apps/console/src/features/config/ConfigPage.tsx:424-427` · narrativo · «UN» (cuenta los tres nombres anteriores «Ajustes & rollback» / antetítulo inglés / menú lateral; ya cerrado, la regla vigente es UN nombre)
`apps/console/src/features/config/ConfigPage.tsx:485-487` · narrativo · ««Alta»» (justifica la ubicación con "antes del registro de bots"; regla ya vigente)

`apps/console/src/features/terminal/fleet.ts:36-39` · narrativo · «TenantSchema» (cuenta que "Folding here used to merge `Steven:operator` con `steven:operator`"; la regla de case-sensitivity se deduce del código) — compactable.

`apps/console/src/features/config/areas.ts:1-86` · 0 líneas (ya limpiado) — invariante puro.

`apps/console/src/features/live/deriva.ts:1-72` · 0 líneas (ya limpiado) — invariante puro; los `caso quota-collector` / `caso gaia` son ejemplos concretos que ayudan a entender qué cae en cada conjunto.

`apps/console/src/features/config/interruptores.ts:1-226` · 0 líneas (ya limpiado) — invariante puro.

`apps/console/src/features/config/Interruptor.tsx:1-157` · 0 líneas (ya limpiado) — invariante puro.

`apps/console/src/features/accounts/quotas.ts:1-172` · 0 líneas (ya limpiado) — invariante puro.

`apps/console/src/nav.ts:1-54` · 0 líneas (ya limpiado) — invariante puro.

`packages/adapter-sdk/src/shared-session/tmux.ts:1-59` · 0 líneas (ya limpiado) — descompuesto a `tmux/{identity,mutation,operations}.ts`; este fichero es barrel.

`packages/adapter-sdk/src/sdk/engine.ts:218-223` · narrativo · «Un» (cuenta el caso "un gateway sin la renovación en fase 'accepted'" — la regla del método `logDroppedQueueRenewal` se explica sola) — compactable.
`packages/adapter-sdk/src/sdk/engine.ts:256-259` · narrativo · «A» (cuenta el caso "A store created by the historical split writer"; la regla es: "si el store tiene un `started` sin outbox, reconstruir y reintentar")

`apps/console/src/api/client.ts:161-161` · ceremonial · «System» (divisor de sección)
`apps/console/src/api/client.ts:228-228` · ceremonial · «Messaging» (divisor de sección)
`apps/console/src/api/client.ts:273-273` · ceremonial · «Agent» (divisor de sección)

`packages/adapter-sdk/src/context/perfil-a-contexto.ts:1-177` · 0 líneas (ya limpiado) — invariante puro; las tres secciones Qué NO hace / De dónde sale / Determinismo son el documento de diseño del módulo, no narrativo.

`apps/console/src/features/live/LiveHypergraph.tsx:36-38` · narrativo · «un» (cuenta el caso "nunca «caído», que era el bug de antes: afirmaba una avería a partir de un silencio"; la regla "no informado no es lo mismo que roto" ya está en el comentario en línea 378)
`apps/console/src/features/live/LiveHypergraph.tsx:222-225` · narrativo · «Tres» (cuenta "Antes las dos últimas compartían texto"; ya cerrado, la regla de tres mensajes distintos es por sí sola)
`apps/console/src/features/live/LiveHypergraph.tsx:257-261` · narrativo · «antes» (cuenta "Antes esto era un `if/else` excluyente y `focusKey` ganaba"; la regla de suma con filtro ya está clara)
`apps/console/src/features/live/LiveHypergraph.tsx:378-380` · narrativo · «Antes» (cuenta "Antes esto era `?? 'down'`, y era un BUG"; la regla ya está como `?? 'unknown'`)

`apps/console/src/features/queues/DeliveryTable.tsx:11-13` · narrativo · «Los» (cuenta "Eran los nombres de la columna `state` de la base"; ya cerrado)
`apps/console/src/features/queues/DeliveryTable.tsx:42-44` · narrativo · «Los» (cuenta "Antes el botón sólo aparecía en 'dead' y por eso 197 entregas de producción no tenían forma de rescate"; la cifra medida de 197 es de un día concreto)
`apps/console/src/features/queues/DeliveryTable.tsx:49-56` · narrativo · «QUÉ» (cuenta "Salido del recorrido del 2026-08-23: «la consola no le explica qué hace ese botón...»"; cita textual del dueño)
`apps/console/src/features/queues/DeliveryTable.tsx:114-120` · narrativo · «Ninguna» (cuenta "Es producción viva con clientes reales dentro... Antes de este cambio, «Replay» era un `<button>` que publicaba directamente")
`apps/console/src/features/queues/DeliveryTable.tsx:175-177` · narrativo · «Se» (cuenta "la queja documentada del operador es que cancelar a mano en la base era irreversible")
`apps/console/src/features/queues/DeliveryTable.tsx:268-274` · narrativo · ««Sin»» (cuenta "31 de las 38 filas de producción pintaban un UNKNOWN ámbar sobre entregas terminadas BIEN"; cifras medidas)

`apps/console/src/features/terminal/cuerpo-del-mensaje.ts:7-7` · mutilado · «100» (doble espacio tras `*`, lista de items rota de un enumerado anterior; el censo ya marcaba "100 items, largo máximo de `body_preview`...") — la línea es la entrada `*  100 items, largo máximo de \`body_preview\` = 240 caracteres exactos, mínimo 4. En pantalla se` que está huérfana de la lista de items que la precedía.
`apps/console/src/features/terminal/cuerpo-del-mensaje.ts:8-11` · narrativo · «leía» (cuenta dos strings truncados reales «…Yo pare lo que habia arranca» y «…El dominio real es stevenvallejo»; cita verbatim, no añade restricción)
`apps/console/src/features/terminal/cuerpo-del-mensaje.ts:13-14` · narrativo · «eso» (frase de moraleja "Eso es mentir por omisión, que es exactamente lo que esta vista existe para no hacer")

`packages/adapter-sdk/src/shared-session/paste-runner.ts:1-8` · 0 líneas (ya limpiado) — descompuesto a `paste-runner/*.ts`; este fichero es barrel.

`apps/console/src/features/accounts/licenses.ts:1-7` · mutilado · «Lecturas» (la cabecera del módulo quedó partida: "tenía su propia página, `LicensesPage`;" + línea rota + "página vive fusionada;" + línea rota + "(features/quotas/ConsumptionSection)") — frase sin sujeto, mutilación mecánica de 2a22107.

`apps/console/src/features/live/AgentDrawer.tsx:57-63` · mutilado · ««Ficheros»» (el comentario de "«Ficheros» va JUNTO a «Directiva»..." queda con la frase cortada "estaba escrita por duplicado en los 14 alias.  sitio; esto es ese sitio." — frase sin verbo, mutilación mecánica) — el censo ya marcaba "sitio; esto es ese sitio."

`apps/console/src/features/messages/roster.ts:23-56` · narrativo · «EL» (bloque grande que cuenta el incidente `gaia` con cita "El universo del roster NO son las membresías" y reconstruye la historia del bug; la regla está compactada en líneas 5-9)

`apps/console/src/mocks/handlers.ts:152-159` · narrativo · «Las» (cuenta "El gateway TODAVÍA NO sirve este endpoint: acá se devuelve un 404 a propósito, que es lo que la consola se va a encontrar en producción hoy")
`apps/console/src/mocks/handlers.ts:161-168` · narrativo · «LOS» (cuenta el fixture de los DOS estados: "`kant` sirve su CLAUDE.md; el resto de los alias contesta 503, que es lo que hace hoy producción entera —el gateway todavía no tiene camino hasta el disco de un agente—")
`apps/console/src/mocks/handlers.ts:169-173` · narrativo · «EL» (cuenta "`openclaw` a propósito para el alias `argos`: es el caso que más se rompe —siete ficheros en vez de uno—")
`apps/console/src/mocks/handlers.ts:303-317` · narrativo · «LAS» (cuenta "comprobado uno por uno el 2026-08-24, `GET /v3/console/agents/:tenant/:alias/directive` devuelve 404" con fechas `2026-08-24` y casos `janus` / `gaia`)
`apps/console/src/mocks/handlers.ts:357-364` · narrativo · «El» (cuenta "comprobado el 2026-08-23 contra producción, responde 200 con las entradas")

`apps/console/src/features/landing/LandingPage.tsx:13-16` · narrativo · «Nace» (cuenta "Nace de dos pedidos del dueño que resultaron ser el mismo: «adapters se convierte en landing con toda la data de console» y «de /live mucha info podría ir simplemente en la landing»"; cita textual del dueño)
`apps/console/src/features/landing/LandingPage.tsx:30-31` · ceremonial · «Los» (re-explica NAV_ENTRIES y useNavAvailability que ya están en sus nombres)
`apps/console/src/features/landing/LandingPage.tsx:152-160` · narrativo · «Acá» (cuenta "Acá vivía el panel «El resto de la consola»: una lista con las siete entradas del menú... Se retira.")

`apps/console/src/features/terminal/plazas.ts:1-49` · 0 líneas (ya limpiado) — invariante puro.

`apps/console/src/features/live/perfil.ts:27-30` · narrativo · «Se» (cuenta "el 16-ago un alias se quedó SORDO —dejó de recibir entregas, sin un solo error visible— porque dos capas contaban el mismo 1200 en unidades distintas"; fecha + cifra medida + diagnóstico ya cerrado)

`apps/console/src/features/messages/ConversationPane.tsx:296-302` · narrativo · «El» (cita el techo `listMessages` corta en 100 mensajes y la nota "(medido en packages/store/src/repository.ts)"; medición pasada)
`apps/console/src/features/messages/ConversationPane.tsx:304-310` · narrativo · «medido» (cuenta "medido en Chrome a 1280x900, con el panel acotado quedaban 42 px de conversación visible, y este párrafo de tres líneas era 30 de los que faltaban")
`apps/console/src/features/messages/ConversationPane.tsx:343-352` · narrativo · «EL» (cuenta "La lista plana anterior mostraba por tarjeta el room, el lane, el actor verificado, el tenant, el trace ENTERO y TODAS las entregas del publish con su tenant destino")
`apps/console/src/features/messages/ConversationPane.tsx:354-364` · narrativo · «EL» (cuenta "Dos motivos, los dos medidos. El primero es la queja textual del recorrido: «el panel de detalle se abre solo sobre un mensaje que nadie eligió». El segundo apareció al abrir la página arreglada en Chrome a 1280x900: con el panel acotado y el detalle desplegado de oficio, quedaban 42 px")
`apps/console/src/features/messages/ConversationPane.tsx:383-387` · narrativo · «EL» (cuenta "el detalle mostraba room, lane, actor, tenant, trace y message id —seis campos de metadatos— y no el mensaje")

`apps/console/src/features/config/CollectionTable.tsx:243-266` · narrativo · «Confirmación» (cuenta "269 px de alto, de los cuales 170 eran el volcado de JSON. En un viewport de 900 px «Confirmar» y «Cancelar» caían en y=999..1039, o sea INVISIBLES"; cifras medidas + historia "el fondo seguía siendo pulsable: con la confirmación abierta se podía apretar «Cerrar sesión» de la cabecera —pasó de verdad durante la revisión—")

`apps/console/src/mocks/browser.ts:1-60` · 0 líneas (ya limpiado) — invariante puro; la cita "Medido en la consola desplegada: al entrar directo a una vista se dibujaba entera, pero al llegar a esa misma vista por el menú medio minuto después la pantalla salía vacía" es la única traza de medición y ya está integrada como regla (mantener vivo el service worker).

`apps/console/src/features/live/capas-pendientes.ts:1-69` · 0 líneas (ya limpiado) — invariante puro.

`ops/tests/test_container_runtime_zombies.py:1-9` · ceremonial · «Regression» (docstring de módulo que repite "verify that the changes to signal_known_tree with can_reap=True do not break safety"; el nombre del fichero ya dice "zombies")
`ops/tests/test_container_runtime_zombies.py:18-19` · ceremonial · «Count» (la docstring de la función repite el nombre `count_zombie_processes`)
`ops/tests/test_container_runtime_zombies.py:31-32` · ceremonial · «Reap» (la docstring de la función repite el nombre `reap_children` y dice "from the guard code" — comentario-meta sobre el origen)
`ops/tests/test_container_runtime_zombies.py:42-46` · ceremonial · «Test» (docstring de la función que dice "Test: Create a child process and exit without reaping it. Verify it becomes a zombie."; lo que ya dice el nombre `test_zombie_creation_without_reap`)
`ops/tests/test_container_runtime_zombies.py:47-47` · ceremonial · «Create» (comenta lo que hace la línea siguiente)
`ops/tests/test_container_runtime_zombies.py:54-54` · ceremonial · «Don't» (explica el "no llamar wait/poll")
`ops/tests/test_container_runtime_zombies.py:82-86` · ceremonial · «Test» (docstring que repite el nombre)
`ops/tests/test_container_runtime_zombies.py:87-87` · ceremonial · «Create» (comenta lo que hace el bucle)
`ops/tests/test_container_runtime_zombies.py:99-99` · ceremonial · «Let» (comenta el sleep)
`ops/tests/test_container_runtime_zombies.py:102-102` · ceremonial · «Count» (comenta la línea siguiente)
`ops/tests/test_container_runtime_zombies.py:105-105` · ceremonial · «Now» (cuenta "Now reap them using the guard's reap_children function" — el censused exacto, precede a la llamada `reap_children()`)
`ops/tests/test_container_runtime_zombies.py:108-108` · ceremonial · «Count» (comenta la línea siguiente)
`ops/tests/test_container_runtime_zombies.py:120-127` · ceremonial · «Test» (docstring que repite el nombre `test_pidfd_persists_after_waitpid`)
`ops/tests/test_container_runtime_zombies.py:146-146` · ceremonial · «Let» (comenta el wait)
`ops/tests/test_container_runtime_zombies.py:162-168` · ceremonial · «Test» (docstring que repite `test_can_reap_true_safety`)
`ops/tests/test_container_runtime_zombies.py:178-178` · ceremonial · «Let» (comenta el sleep)
`ops/tests/test_container_runtime_zombies.py:189-190` · invariante · «The» (explica la invariante de `process.wait()` post-reap)
`ops/tests/test_container_runtime_zombies.py:200-200` · ceremonial · «Run» (repite el nombre `main`)
`ops/tests/test_container_runtime_zombies.py:203-203` · ceremonial · «Only» (comenta la guarda de /proc)

`ops/scripts/source-digest.py:1-92` · 0 líneas (ya limpiado) — el docstring del módulo cuenta el incidente narrado del censo ("el gate no detectaba forgery, estaba manufacturando el incentivo para ello") pero está compactado en una sola frase corta en líneas 10-11 ("Evidence that is expensive to regenerate and trivially invalidated is evidence people hand-edit instead of re-running"). El resto son secciones "Why domains exist" / "The rule implemented here" / "Domains" / "Justification for the exclusions" que son el documento de diseño del invariante, no narrativo.

## CONSERVAR EXPLÍCITAMENTE

- `apps/console/src/features/live/agent-state.ts:12-19` — la precedencia `down > ... > idle` es el invariante del union `LiveState`.
- `apps/console/src/features/config/collection-table.ts:91-97` — la regla del `…` final "no es decorativo" y la cuenta por puntos de código.
- `apps/console/src/features/landing/landing.ts:39-44` — la separación entre "no hay incidencias" y "no lo pude leer".
- `apps/console/src/features/live/LiveHypergraph.tsx:104-109` — la regla de `topologyError` ≠ "no hay salas".
- `apps/console/src/features/live/LiveHypergraph.tsx:206-213` — la regla del `prefers-reduced-motion` para SMIL.
- `apps/console/src/features/messages/DeliveryTable.tsx:25-31` — `SIN_FALLO_TODAVIA` es la invariante de "sin error" por estado.
- `apps/console/src/features/terminal/cuerpo-del-mensaje.ts:27-36` — la regla del `>=` (error caro es presentar como completo lo recortado).
- `packages/adapter-sdk/src/sdk/engine.ts:519-522` — invariante de `awaitSessionTurn`.
- `packages/adapter-sdk/src/sdk/engine.ts:654-661` — invariante de por qué una renovación no lleva texto de progreso.
- `ops/tests/test_container_runtime_zombies.py:189-196` — la invariante de `process.wait()` post-reap (lo único que queda como invariante real en este fichero).

## Tabla resumen

| fichero | líneas a borrar | narrativo | mutilado | ceremonial |
|---|---:|---:|---:|---:|
| apps/console/src/features/live/agent-state.ts | 3 | 2 | 0 | 1 |
| apps/console/src/features/live/LiveFleetPage.tsx | 2 | 0 | 0 | 2 |
| apps/console/src/api/types.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/config/collection-table.ts | 2 | 2 | 0 | 0 |
| packages/adapter-sdk/src/harnesses/shared.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/mocks/data.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/terminal/denegaciones.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/terminal/api.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/live/directiva.ts | 8 | 8 | 0 | 0 |
| apps/console/src/features/landing/landing.ts | 7 | 7 | 0 | 0 |
| apps/console/src/features/topology/hypergraph-layout.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/config/ConfigPage.tsx | 7 | 7 | 0 | 0 |
| apps/console/src/features/terminal/fleet.ts | 4 | 4 | 0 | 0 |
| apps/console/src/features/config/areas.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/live/deriva.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/config/interruptores.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/config/Interruptor.tsx | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/accounts/quotas.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/nav.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| packages/adapter-sdk/src/shared-session/tmux.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| packages/adapter-sdk/src/sdk/engine.ts | 10 | 10 | 0 | 0 |
| apps/console/src/api/client.ts | 3 | 0 | 0 | 3 |
| packages/adapter-sdk/src/context/perfil-a-contexto.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/live/LiveHypergraph.tsx | 15 | 15 | 0 | 0 |
| apps/console/src/features/queues/DeliveryTable.tsx | 31 | 31 | 0 | 0 |
| apps/console/src/features/terminal/cuerpo-del-mensaje.ts | 7 | 6 | 1 | 0 |
| packages/adapter-sdk/src/shared-session/paste-runner.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/accounts/licenses.ts | 7 | 0 | 7 | 0 |
| apps/console/src/features/live/AgentDrawer.tsx | 7 | 0 | 7 | 0 |
| apps/console/src/features/messages/roster.ts | 34 | 34 | 0 | 0 |
| apps/console/src/mocks/handlers.ts | 44 | 44 | 0 | 0 |
| apps/console/src/features/landing/LandingPage.tsx | 15 | 13 | 0 | 2 |
| apps/console/src/features/terminal/plazas.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/live/perfil.ts | 4 | 4 | 0 | 0 |
| apps/console/src/features/messages/ConversationPane.tsx | 40 | 40 | 0 | 0 |
| apps/console/src/features/config/CollectionTable.tsx | 24 | 24 | 0 | 0 |
| apps/console/src/mocks/browser.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| apps/console/src/features/live/capas-pendientes.ts | 0 (ya limpiado) | 0 | 0 | 0 |
| ops/tests/test_container_runtime_zombies.py | 51 | 2 | 0 | 49 |
| ops/scripts/source-digest.py | 0 (ya limpiado) | 0 | 0 | 0 |
| **TOTAL** | **325** | **253** | **15** | **57** |

## Ficheros del sector no alcanzados a revisar (del segundo lote 6-9 borrables)

- `features/queues/filtro-de-colas.ts` — revisado adicionalmente, ver líneas arriba (narrativo).
- `features/queues/ultimo-error.ts` — revisado adicionalmente, ver líneas arriba (narrativo).
- `features/live/role-brief.ts` — revisado adicionalmente, ya limpiado.
- `features/queues/foco-de-entrega.ts` — revisado adicionalmente, ver líneas arriba (narrativo).
- `features/terminal/session.ts` — revisado adicionalmente, ya limpiado.
- `features/accounts/AccountRoutingDetail.tsx` — revisado adicionalmente, ya limpiado.
- `features/messages/MessagesPage.tsx` — revisado adicionalmente, ver líneas arriba (narrativo).
- `mocks/terminal-demo.ts` — revisado adicionalmente, ver líneas arriba (narrativo).
