# P14 — parcial store+protocol (sector 1 del censo)

Método: lectura completa de los 21 ficheros del sector, verificación de cada rango con `sed -n a,bp`
antes de anotarlo. Rangos cerrados inclusivos de líneas que se borran ENTERAS.
Cuando el rango incluye los delimitadores `/** */` de un bloque que desaparece entero, lleva `[cierra-bloque]`.
Cuando incluye una línea en blanco adyacente (para no dejar dos blancos seguidos ni un blanco al inicio
de fichero), lleva `[+blanco]`.

Sección **COMPACTAR** por fichero = historia real que NO se puede quitar por líneas enteras sin mutilar
la frase (prosa envuelta): requiere reescritura a mano, con el texto exacto propuesto.

---

## packages/store/src/repository/deliveries.ts

Sin entradas. El fichero se partió en `deliveries/*` y hoy son 27 líneas de re-export SIN NI UN COMENTARIO.
El censo lo daba como el peor de la zona (294 comentarios, 118 borrables, S1..S6 huérfanos): ese contenido ya no está acá.

TOTAL packages/store/src/repository/deliveries.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE: nada que conservar (0 comentarios).

---

## packages/protocol/src/schemas.ts

`packages/protocol/src/schemas.ts:66-66` · ceremonial · «Largo»
`packages/protocol/src/schemas.ts:128-128` · ceremonial · «Tipos»
`packages/protocol/src/schemas.ts:162-162` · ceremonial · «Mapeo»
`packages/protocol/src/schemas.ts:198-198` · ceremonial · «Lee»
`packages/protocol/src/schemas.ts:243-246` · ceremonial · «Tipos» · [cierra-bloque]
`packages/protocol/src/schemas.ts:283-283` · ceremonial · «Identifica»
`packages/protocol/src/schemas.ts:536-540` · narrativo · «`repository.ts`»

Notas de borrado:
- 536-540 deja el bloque `/* ... */` de 533-546 con su título (534), una línea en blanco (535) y el
  párrafo invariante de rangos (541-545). No toca delimitadores.

COMPACTAR (no borrable por líneas):
- 534: quitar la cola narrativa. Queda: ` * LOS CINCO TOPES DE LA MIGRACIÓN 019.`
- 574-585 (`max_concurrent_deliveries`): la historia («no estaba en ninguna pantalla: su única vía de
  cambio era un `UPDATE` a mano») está partida entre el final de 576 y 577; 579-584 son invariante puro.
  Reescribir 575-577 a dos líneas: «El techo REAL de entregas en vuelo de este agente (columna
  `max_concurrent_deliveries`, migración 015). `repository.ts` lo aplica al repartir cupo.»
- 726-741 (`execution_started`): 731-733 narra el modo de falla del reaper viejo («usaba esa señal…
  mandaba a `dead` trabajo que nunca corrió»). El invariante que debe sobrevivir está en 729-731
  («el ACK `started` NO prueba ejecución: el SDK lo emite en `handleDelivery` antes de llamar al harness»).
- 894-901: la cola de 900 («que es exactamente la deriva que dejó el frame fuera del esquema la primera
  vez») es historia; el resto de la frase es el invariante de acoplamiento en compilación.

TOTAL packages/protocol/src/schemas.ts: 14 líneas

CONSERVAR EXPLÍCITAMENTE:
- 862-878 (`self_role`): parece un ensayo pero es el invariante de wire más caro del fichero
  (`.strict()` + puntos de código vs UTF-16). Es el ejemplo que el propio censo marcó como invariante.
- 541-545: los rangos copiados del CHECK de Postgres. Aunque estén dentro del bloque de la 019, no son historia.
- 309-312 (priority): dice por qué NO se aplica el techo acá; suena a excusa, es política.
- 370-376 / 380-382 / 391-399 / 409-411 (cuotas): explican por qué un valor mal leído auto-pausa una
  suscripción paga. Cifras («schemaVersion 2») son contrato, no anécdota.

---

## packages/store/src/repository/observability/policy.ts

Sin entradas borrables por línea. Es prosa envuelta: cada párrafo mezcla el límite con su porqué.

COMPACTAR (no borrable por líneas):
- 93-98: quitar la cifra narrada «las 1.041 pruebas de vida intermedias». Reescritura propuesta del
  párrafo: «Un ACK de renovación dice "el harness sigue vivo": su valor forense se agota cuando la
  entrega termina. 6 h es más que el techo típico de una entrega larga en curso, así que ninguna
  renovación se borra mientras su entrega sigue viva.» (invariante que debe sobrevivir: línea 91, «6 h»).
- 205-208: quitar la referencia al incidente («…y es exactamente la realimentación positiva que describe
  el incidente: cada muerte generaba más carga, que generaba más muertes») y cerrar la frase de 205 en
  «…y el trabajo agéntico tarda lo que tarda.» (invariante que debe sobrevivir: línea 200, el backoff).

TOTAL packages/store/src/repository/observability/policy.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 119-146 (`DISPOSABLE_AUDIT_ACTIONS`): lista blanca con las dos acciones que costarían caro borrar.
  Es la pieza más importante del fichero; el tono («la decisión más importante») no la hace narrativa.
- 66-79 (`leaseCapMsSql`): «exactamente el modo de falla que ya dejó una vez a la flota…» roza lo
  narrativo, pero la frase entera explica por qué los CASE van anidados (orden de evaluación en Postgres).
- 29-36, 48-59, 173-196: contratos de techo/ancla y palancas de emergencia.

---

## packages/store/src/repository/agents/fanin.ts

Sin entradas. 289 líneas, todos los comentarios son visibilidad default-deny y contrato del read-model.
**El bloque SQL `--` de las líneas 987-991 que el censo mandaba no tocar YA NO EXISTE**: el fichero se
partió en `fanin/*` y hoy tiene 289 líneas, no ~1500. No hay ni un `--` dentro de template literal en este fichero.

TOTAL packages/store/src/repository/agents/fanin.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 63-75 (`agentChain`): explica por qué la visibilidad se decide por nodo y nunca en el llamador. Largo, pero es seguridad cross-tenant.
- 49: «Absence and invisibility share one error…» — anti-oráculo de enumeración.
- 15-23: default-deny del detalle de aviso agregado.

---

## packages/store/src/repository/agents/chain-control.ts

Sin entradas. La cifra «148 repeticiones de una misma arista medidas en prod» que citaba el censo no
está en este fichero (se fue a `chain-control/*`).

TOTAL packages/store/src/repository/agents/chain-control.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 67-68: `FOR UPDATE` del gate como contracara del `FOR SHARE` de `materializeAgentOutputs`.
- 122-124: la resta de un salto al reanudar. Sin ella cada gate come presupuesto de cadena.
- 60-65: la reanudación restaura la correlación y por eso NO arranca una cadena nueva.

---

## packages/store/src/repository/observability.ts

Sin entradas. Las «881 entregas» del censo no están en este fichero.

TOTAL packages/store/src/repository/observability.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 113-116: por qué `FLEET_ACTIVITY_QUERY` no lleva locks ni funciones de ventana (Postgres rechaza la combinación al parsear).
- 126-131 y 179-181: semántica de NULL (`lease_online`, `seconds_since_last_ack`, `rooms: []`). `Number(null)` pintaría lo contrario de la verdad.
- 316-317: por qué «recortada» se decide contra el total y no contra `items.length === limit`.

---

## packages/protocol/src/agent-profile.ts

`packages/protocol/src/agent-profile.ts:12-12` · ceremonial · «Largo»
`packages/protocol/src/agent-profile.ts:17-17` · ceremonial · «Longitud»
`packages/protocol/src/agent-profile.ts:22-22` · ceremonial · «Límites»
`packages/protocol/src/agent-profile.ts:24-24` · ceremonial · «Identidad»
`packages/protocol/src/agent-profile.ts:26-26` · ceremonial · «Rol»
`packages/protocol/src/agent-profile.ts:28-28` · ceremonial · «Instrucciones»
`packages/protocol/src/agent-profile.ts:50-50` · ceremonial · «Perfil»
`packages/protocol/src/agent-profile.ts:66-66` · ceremonial · «Error»
`packages/protocol/src/agent-profile.ts:81-81` · ceremonial · «Normaliza»
`packages/protocol/src/agent-profile.ts:99-99` · ceremonial · «Normaliza»
`packages/protocol/src/agent-profile.ts:130-130` · ceremonial · «Calcula»
`packages/protocol/src/agent-profile.ts:142-142` · ceremonial · «Valida»
`packages/protocol/src/agent-profile.ts:165-165` · ceremonial · «Crea»
`packages/protocol/src/agent-profile.ts:205-205` · ceremonial · «Cuotas»
`packages/protocol/src/agent-profile.ts:213-213` · ceremonial · «Configuración»
`packages/protocol/src/agent-profile.ts:221-221` · ceremonial · «Hechos»
`packages/protocol/src/agent-profile.ts:230-230` · ceremonial · «Contexto»
`packages/protocol/src/agent-profile.ts:236-237` · ceremonial · «──» · [+blanco]
`packages/protocol/src/agent-profile.ts:238-238` · ceremonial · «Renderiza»
`packages/protocol/src/agent-profile.ts:243-243` · ceremonial · «Renderiza»
`packages/protocol/src/agent-profile.ts:249-249` · ceremonial · «Renderiza»
`packages/protocol/src/agent-profile.ts:260-260` · ceremonial · «Renderiza»
`packages/protocol/src/agent-profile.ts:271-271` · ceremonial · «Renderiza»
`packages/protocol/src/agent-profile.ts:283-286` · ceremonial · «Compone» · [cierra-bloque]

TOTAL packages/protocol/src/agent-profile.ts: 28 líneas

CONSERVAR EXPLÍCITAMENTE:
- 3-10: la regla de doble unidad (`max(code points, UTF-16)`). Es la razón de existir de `measureStrictestUnits`.
- 30, 32, 34: `item` vs `items` vs `total` — desambiguan tres claves que se confunden entre sí; no son calco del nombre.
- 38 y 43: «en el orden en que se suman al presupuesto y se renderizan» — el orden es contrato.
- 54, 56, 58: «NULL = no declarado». Semántica de ausencia.
- 173-189 (LOS HECHOS DERIVADOS): parece ensayo pero declara la única fuente de verdad
  (no se copian a `agent_profiles`) y por qué el tipo vive en `@cauce/protocol` y no en el SDK.
- 196-201: `notify` exige rol Y destino aprobado; default-deny por lista.
- 226: «Alias alcanzables por ACL» — dice de dónde sale el dato, no repite el nombre.

---

## packages/store/src/agent-profile.ts

`packages/store/src/agent-profile.ts:9-12` · ceremonial · «Repositorio» · [cierra-bloque] [+blanco]
`packages/store/src/agent-profile.ts:31-33` · ceremonial · «Representa» · [cierra-bloque]
`packages/store/src/agent-profile.ts:65-65` · ceremonial · «Fallo»
`packages/store/src/agent-profile.ts:95-97` · ceremonial · «Convierte» · [cierra-bloque]
`packages/store/src/agent-profile.ts:150-152` · ceremonial · «Normaliza» · [cierra-bloque]
`packages/store/src/agent-profile.ts:158-160` · ceremonial · «Reemplazo» · [cierra-bloque]
`packages/store/src/agent-profile.ts:334-336` · ceremonial · «Elimina» · [cierra-bloque]
`packages/store/src/agent-profile.ts:344-346` · ceremonial · «Obtiene» · [cierra-bloque]
`packages/store/src/agent-profile.ts:422-424` · ceremonial · «Consulta» · [cierra-bloque]
`packages/store/src/agent-profile.ts:437-439` · ceremonial · «Consulta» · [cierra-bloque]
`packages/store/src/agent-profile.ts:460-462` · ceremonial · «Consulta» · [cierra-bloque]

Notas de borrado:
- 9-12 incluye la línea 12 (en blanco) porque la 8 también lo está: borrar sólo 9-11 dejaría dos blancos seguidos.

TOTAL packages/store/src/agent-profile.ts: 32 líneas

CONSERVAR EXPLÍCITAMENTE:
- 13: «Las columnas, en el orden de la tabla. Una sola copia para el SELECT y para el RETURNING.» — el orden y la copia única son la restricción.
- 43: «conserva los literales útiles al CAS».
- 115-117 (`read`): «devuelve un perfil vacío si no existe fila» es un contrato que el cuerpo de una línea NO muestra.
- 216-222 (`markApplied`): un ACK tardío nunca hace retroceder un `applied_revision` mayor. Idempotencia real.
- 290: la auditoría nunca incluye el cuerpo autorado del perfil. Seguridad.
- 484: «`undefined` cuando no hay observación fresca».

---

## packages/store/src/repository/deliveries/control.ts

`packages/store/src/repository/deliveries/control.ts:37-41` · ceremonial · «Proporciona»

Notas de borrado:
- 37 es la línea ` *` que separa; 38-41 son el «1. 2. 3.» que narra los pasos que el cuerpo ya ejecuta.
  Tras el borrado el bloque queda 34-36 + 42 (` *`) + 43…, sin tocar delimitadores.

TOTAL packages/store/src/repository/deliveries/control.ts: 5 líneas

CONSERVAR EXPLÍCITAMENTE:
- 43-48: «NO INVENTA UN ESTADO NUEVO» — por qué termina en `dead` y no en un `cancelled` nuevo. Es la decisión de esquema.
- 50-54: por qué NO manda ningún frame al adaptador (degradación correcta cuando el adaptador está muerto).
- 65-68: `FOR UPDATE OF d` sin función de ventana; Postgres rechaza la combinación al parsear.
- 90-92: limpiar los campos de vallado no es cosmético (si no, la garra se sigue renovando).
- 164-177: el «~90 % del volumen de la tabla» es un límite medido que justifica la retención por tipo; NO es anécdota.

---

## packages/store/src/repository/quotas.ts

`packages/store/src/repository/quotas.ts:489-498` · narrativo · «Decía»
`packages/store/src/repository/quotas.ts:499-502` · narrativo · «El»

Notas de borrado:
- Tras borrar los dos rangos queda: 484-486 (el porqué del recupero) + 487 (` //`) + 488 (el invariante
  «`collector_tenant` es parte de la clave y por lo tanto DEBE estar en las dos consultas»). Ese es el
  «compactar»: sobrevive 488, se va el relato del 42P10, del «0 filas» y de las «72 h».
- 499 es la línea ` //` separadora del párrafo que se borra; va incluida para no dejarla huérfana.

TOTAL packages/store/src/repository/quotas.ts: 14 líneas

CONSERVAR EXPLÍCITAMENTE:
- 240-243: el aislamiento es por TENANT y nunca por nombre de host (dos tenants con el mismo host compartirían panel).
- 526-531: exige que la cuenta la pague el tenant que publica. Sin ese filtro un POST bien formado apaga la flota de otro tenant. Suena a incidente, es el modelo de amenaza.
- 464-466 y 370-376 de schemas: rechazar un `schema_version` desconocido en vez de mapear a ciegas.
- 94-99 y 565-567: el marcador antepuesto SIEMPRE, para que una nota custom no esconda «cuenta desconocida».
- 601-602, 624-626, 644-647, 662: guarda anti-retroceso, pausa acotada al collection_id, reanudación global, DELETE acotado.
- 219-220: la cadena `'Steven:quota-collector'` es un `collector_tenant` de ejemplo (identidad mTLS), no una cita de persona.

---

## packages/store/src/repository/outbox.ts

Sin entradas. 17 líneas de re-export, cero comentarios. Las «197 entregas de producción» que el censo
daba por duplicadas entre `outbox.ts` y `deliveries.ts` no están en ninguno de los dos: ambos ficheros se partieron.

TOTAL packages/store/src/repository/outbox.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE: nada que conservar (0 comentarios).

---

## packages/store/src/configuration.ts

`packages/store/src/configuration.ts:297-297` · mutilado · «(línea `//` vacía, sin texto)»

Notas de borrado:
- 297 es un `//` solo, resto de una limpieza mecánica, entre el bloque 293-296 y el `if` de 298.

COMPACTAR (no borrable por líneas):
- 88-94 (`max_concurrent_deliveries` en el SELECT de `agents`): 90-93 es historia («No estaba en el
  snapshot ni en la mutación… Esa salida ahora tiene pantalla») pero arranca a mitad de la línea 90.
  Reescribir el bloque a: «`max_concurrent_deliveries` (migración 015) es el techo REAL de entregas en
  vuelo de un agente: `repository.ts` lo aplica al repartir cupo, y `NULL` es la salida de emergencia
  documentada por la 015.» (invariante que debe sobrevivir: 89-90).

TOTAL packages/store/src/configuration.ts: 1 línea

CONSERVAR EXPLÍCITAMENTE:
- 100-104: `credential_ref` nunca sale de la base, ni para su pagador; qué ve un tenant prestatario. Seguridad multi-tenant.
- 293-296: las cuatro resources del registro quedan hub-only por el default-deny de abajo y NO por una regla que un edit futuro pueda ablandar.
- 287-288: renunciar al contacto previo es decisión de hub aunque el destino sea del propio tenant.
- 125: el ORDER BY por la columna numérica evita el orden lexicográfico sobre `id::text`.
- 75-77: fotografiar todos los topes para que el rollback restaure los valores exactos.

---

## packages/store/src/repository/messages.ts

Sin entradas. Los ~15 borrables que estimaba el censo estaban en el texto que hoy vive en `messages/receipts.ts`.

TOTAL packages/store/src/repository/messages.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 246-250: reconciliar UN efecto durable por vez en el orden autenticado del head; falla cerrado ante corrupción posterior.
- 267-270 y 290-292: por qué se reusa la reserva más vieja y por qué se cierra la obsoleta bajo el candado del actor.
- 318-321: una reserva sin fila de idempotencia no es un efecto; un efecto confirmado nunca se desaloja.

---

## packages/store/src/repository/agents/notifications.ts

Sin entradas. Los siete pasos numerados 1-7 son el motor de autorización: cada número trae la razón
(orden fijo de candados, default-deny, `clock_timestamp()`, por qué la cadena es `source_root_message_id`,
por qué zona horaria desconocida cae a UTC en vez de tirar). Ninguno narra un paso obvio.

TOTAL packages/store/src/repository/agents/notifications.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 137-139: orden fijo de los dos `pg_advisory_xact_lock` + handles ordenados = sin ciclo de candados.
- 233-235: contar sobre `root_message_id` desactivaría el límite en silencio.
- 292-295: la raíz de correlación del relay es la notificación misma; reusar la de entrada mataría el «Recibido» pendiente.
- 326-328: por qué NO hay `ON CONFLICT`.
- 404-414 y 440-442: la notificación nunca cuenta como hija de la delegación; ejecución ambigua nunca se convierte en un mensaje a un humano.

---

## packages/protocol/src/ficheros-del-arnes.ts

`packages/protocol/src/ficheros-del-arnes.ts:10-11` · ceremonial · «`MEMORY.md`»
`packages/protocol/src/ficheros-del-arnes.ts:14-15` · ceremonial · «──» · [+blanco]
`packages/protocol/src/ficheros-del-arnes.ts:24-24` · ceremonial · «Error»
`packages/protocol/src/ficheros-del-arnes.ts:40-41` · ceremonial · «──» · [+blanco]
`packages/protocol/src/ficheros-del-arnes.ts:66-67` · ceremonial · «──» · [+blanco]
`packages/protocol/src/ficheros-del-arnes.ts:100-100` · ceremonial · «MEMORY.md»
`packages/protocol/src/ficheros-del-arnes.ts:132-135` · ceremonial · «Ficheros» · [cierra-bloque]
`packages/protocol/src/ficheros-del-arnes.ts:147-147` · ceremonial · «MEMORY»
`packages/protocol/src/ficheros-del-arnes.ts:157-157` · ceremonial · «El»
`packages/protocol/src/ficheros-del-arnes.ts:163-163` · ceremonial · «Si»
`packages/protocol/src/ficheros-del-arnes.ts:204-204` · ceremonial · «El»
`packages/protocol/src/ficheros-del-arnes.ts:209-209` · ceremonial · «Comprueba»
`packages/protocol/src/ficheros-del-arnes.ts:220-220` · ceremonial · «Valida»

Notas de borrado:
- La frase «MEMORY.md y HEARTBEAT.md son gestionados por el agente» aparece CUATRO veces (11, 100, 147, 215).
  Se borran tres (10-11, 100, 147) y **sobrevive la 215**, que es la que está sobre `esDelAgente()`, la
  función que codifica la regla. La política («si existe no se toca; si falta se crea vacío») ya vive en 46.
- 10-11 deja el encabezado del módulo 6-9 + 12 (` */`) intacto.

TOTAL packages/protocol/src/ficheros-del-arnes.ts: 20 líneas

CONSERVAR EXPLÍCITAMENTE:
- 44 y 46: la semántica exacta de las dos políticas («byte a byte todo lo de fuera» / «solo-si-falta»).
- 58: un arnés desconocido no recibe NINGÚN fichero (default-deny).
- 166: guarda de pertenencia — sólo se modifica o retira si el bloque es del MISMO alias. Es lo que impide que un alias pise el bloque de otro.
- 215: la única copia que queda de la regla MEMORY/HEARTBEAT, sobre su función.
- 225: los ficheros del agente no computan para los topes.
- 16 y 19: «medidos en unidades UTF-16» y «en el orden en que se emiten».

---

## packages/store/src/accounts.ts

`packages/store/src/accounts.ts:1-5` · ceremonial · «Selector» · [cierra-bloque] [+blanco]
`packages/store/src/accounts.ts:66-66` · ceremonial · «Fila»
`packages/store/src/accounts.ts:85-87` · ceremonial · «Consulta» · [cierra-bloque]
`packages/store/src/accounts.ts:120-122` · ceremonial · «Actualiza» · [cierra-bloque]
`packages/store/src/accounts.ts:140-142` · ceremonial · «Selecciona» · [cierra-bloque]

Notas de borrado:
- 1-5 incluye la línea 5 (en blanco) para que el fichero arranque directo en el `import` de la 6.

TOTAL packages/store/src/accounts.ts: 15 líneas

CONSERVAR EXPLÍCITAMENTE:
- 205-214: «El orden de los chequeos ES la semántica y no es intercambiable» + los tres numerados. Es la especificación del selector, no una narración.
- 10-13: el prefijo de pausa automática; es lo que distingue pausa de máquina de pausa de humano en el `LIKE` del UPDATE.
- 17-26: cada `AccountSkipReason` con la condición SQL exacta que lo produce.
- 165-166: se evalúa TODA la lista para que el failover sea auditable; «≤ 6 filas por alias en el peor caso real» es un límite medido que justifica el bucle.
- 250 y 261-263: pausa sin horizonte necesita un humano; una pausa manual sin `paused_until` vigente conserva su motivo.
- 79 y 81: semántica de NULL de la ventana agotada.

---

## packages/store/src/db.ts

Sin entradas. Todo el fichero son quirks reales del driver `pg` y del ciclo de vida del socket
(idle-client errors, `release(true)`, `pg_terminate_backend`, el pool wait que no se puede cancelar).
Cero historia, cero calco. El censo estimaba 10 borrables; no encontré ninguna.

TOTAL packages/store/src/db.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 164: `node-postgres` no expone cancelación dura del socket en el tipo público de `PoolClient`.
- 127-128 y 265-268: un cliente en préstamo necesita su propio listener o una terminación del backend se vuelve un error no capturado.
- 185-187: cerrar el TCP no despierta a un backend bloqueado; hay que señalizarlo con un checkout nuevo.
- 284-285: tras un COMMIT exitoso, un abort que llega después NO puede reportarse como cancelación.
- 209-210 y 305: la espera del pool no se puede cancelar; el outbox es el respaldo durable del wake.

---

## packages/protocol/src/marcas-de-bloque.ts

`packages/protocol/src/marcas-de-bloque.ts:6-6` · ceremonial · «Versión»
`packages/protocol/src/marcas-de-bloque.ts:13-13` · ceremonial · «Versión»
`packages/protocol/src/marcas-de-bloque.ts:40-40` · ceremonial · «Extrae»
`packages/protocol/src/marcas-de-bloque.ts:49-49` · ceremonial · «Inserta»
`packages/protocol/src/marcas-de-bloque.ts:62-62` · ceremonial · «El»
`packages/protocol/src/marcas-de-bloque.ts:67-67` · ceremonial · «Inserta»
`packages/protocol/src/marcas-de-bloque.ts:72-72` · ceremonial · «El»
`packages/protocol/src/marcas-de-bloque.ts:77-77` · ceremonial · «Inserta»
`packages/protocol/src/marcas-de-bloque.ts:82-82` · ceremonial · «Quita»
`packages/protocol/src/marcas-de-bloque.ts:94-94` · ceremonial · «Devuelve»

TOTAL packages/protocol/src/marcas-de-bloque.ts: 10 líneas

CONSERVAR EXPLÍCITAMENTE:
- 19-21 (`parDeMarcas`): «la ÚLTIMA apertura que cuente con un cierre posterior válido» — es la regla de
  desempate ante marcas repetidas y el nombre de la función no la dice.
- 1-4: encabezado del módulo; es lo único que explica que las marcas son HTML y que el bloque es gestionado.

---

## packages/protocol/src/publish-receipt.ts

Sin entradas. 152 líneas, todos los comentarios son contrato de idempotencia o separación de dominio.

TOTAL packages/protocol/src/publish-receipt.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 4-10: «Do not add domain separation to `publishRequestHash`» — hay filas ya persistidas con esos bytes exactos; cambiarlos convierte cada reintento válido en un 409.
- 30: por qué `request_id`/`trace_id` salen del hash semántico.
- 64-69: por qué ESTE sí lleva separador de dominio explícito (no tiene filas históricas).
- 102-107: es un digest, no un secreto ni una firma; sirve para rechazar recibos mezclados/rancios.
- 131: «the one protocol-owned receipt» — afirma unicidad de constructor; roza lo ceremonial pero es la regla que impide un segundo armador de recibos.

---

## packages/protocol/src/priority.ts

Sin entradas. 30 líneas, 15 de comentario, todas bandas y techos. Confirmado como el contraejemplo
positivo que decía el censo.

TOTAL packages/protocol/src/priority.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 1-8: las tres bandas (-100..50 agente / 51..59 reservado / 60..100 humano). El hueco reservado es lo que hace legible cualquier número futuro.
- 10, 13, 16, 27: cada constante dice quién puede emitirla; no es calco del nombre.

---

## packages/store/src/migrate-cli.ts

Sin entradas. 6 líneas de comentario, todas gate operacional (qué entrypoint es canónico y por qué se
rechaza cualquier entrada ambigua ANTES de leer `DATABASE_URL`).

TOTAL packages/store/src/migrate-cli.ts: 0 líneas

CONSERVAR EXPLÍCITAMENTE:
- 5-10: rechazar todo entrypoint ambiguo (incluido un `NODE_ENV` sin definir) antes de abrir un socket, y que `deploy/migrate.mjs` es el envoltorio canónico que hace la sonda TLS obligatoria.

---

## Resumen

| fichero | líneas a borrar | narrativo | mutilado | ceremonial |
|---|---|---|---|---|
| `packages/store/src/repository/deliveries.ts` | 0 | 0 | 0 | 0 |
| `packages/protocol/src/schemas.ts` | 14 | 5 | 0 | 9 |
| `packages/store/src/repository/observability/policy.ts` | 0 | 0 | 0 | 0 |
| `packages/store/src/repository/agents/fanin.ts` | 0 | 0 | 0 | 0 |
| `packages/store/src/repository/agents/chain-control.ts` | 0 | 0 | 0 | 0 |
| `packages/store/src/repository/observability.ts` | 0 | 0 | 0 | 0 |
| `packages/protocol/src/agent-profile.ts` | 28 | 0 | 0 | 28 |
| `packages/store/src/agent-profile.ts` | 32 | 0 | 0 | 32 |
| `packages/store/src/repository/deliveries/control.ts` | 5 | 0 | 0 | 5 |
| `packages/store/src/repository/quotas.ts` | 14 | 14 | 0 | 0 |
| `packages/store/src/repository/outbox.ts` | 0 | 0 | 0 | 0 |
| `packages/store/src/configuration.ts` | 1 | 0 | 1 | 0 |
| `packages/store/src/repository/messages.ts` | 0 | 0 | 0 | 0 |
| `packages/store/src/repository/agents/notifications.ts` | 0 | 0 | 0 | 0 |
| `packages/protocol/src/ficheros-del-arnes.ts` | 20 | 0 | 0 | 20 |
| `packages/store/src/accounts.ts` | 15 | 0 | 0 | 15 |
| `packages/store/src/db.ts` | 0 | 0 | 0 | 0 |
| `packages/protocol/src/marcas-de-bloque.ts` | 10 | 0 | 0 | 10 |
| `packages/protocol/src/publish-receipt.ts` | 0 | 0 | 0 | 0 |
| `packages/protocol/src/priority.ts` | 0 | 0 | 0 | 0 |
| `packages/store/src/migrate-cli.ts` | 0 | 0 | 0 | 0 |
| **TOTAL** | **139** | **19** | **1** | **119** |

Ficheros con entradas: 9 de 21. Ficheros ya limpios: 12.
Entradas de COMPACTAR (reescritura a mano, no borrado por línea): 7 — schemas.ts ×4, policy.ts ×2, configuration.ts ×1.
