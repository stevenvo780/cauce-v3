# ADR-008: guardia de contaminación del contexto y recarga explícita

**Estado:** aceptado y completo en el gateway. La función de veredicto, el contador, las dos rutas
de recarga, la escritura gobernada de documentos (`PUT .../documents/:kind/content`) y **el PUT del
perfil** (`agent-profile.routes.ts`) pasan por la guardia; la migración `041` guarda el diario que
hace legible el histórico. Ningún arnés se reinicia por esto, ni antes ni después.

## Contexto

Cauce escribe los ficheros de gobierno de un alias —`CLAUDE.md`, `AGENTS.md`, los del workspace de
openclaw— dentro de su contenedor. Toda la seguridad de esa escritura descansa en una suposición que
la propia flota **ya viola en dos sitios**, documentados en el §4 de
`docs/directiva-ficheros-del-agente.md`:

- **`ws-isa` y `ws-isa-workspace`, los dos en kratos, montan el MISMO
  `/datos/agents/isa-config/.claude`.** Ahí escribir «el `CLAUDE.md` de un alias» cambia el del
  otro. No hay dos ficheros: hay uno con dos dueños declarados.
- **`ws-humanizar` aloja dos alias, atlas y kratos, con un solo `$HOME`.** Hoy no chocan sólo porque
  usan arneses distintos —uno lee `AGENTS.md` y el otro `CLAUDE.md`—, y dejarían de no chocar en
  cuanto los dos fueran claude. Es decir: no choca por una coincidencia de configuración, no por un
  control.

El generador ya se defiende de una parte de esto: `ficherosDelArnes` se niega a reescribir un bloque
gestionado cuyo renglón `<!-- alias: tenant/alias -->` declara otro dueño, y
`agent-profile-runtime.ts` traduce esa negativa en un `409`. Pero eso protege **el momento de
escribir**, y sólo mirando el bloque. No dice nada de un fichero que ya quedó contaminado, no mira
la huella medida contra la expectativa registrada, y no deja rastro: un `409` con el texto «contiene
un bloque gestionado de otro alias» se pierde en la pantalla de quien lo vio.

Hay además un segundo modo de fallo, más silencioso. Cuando la composición del perfil cambia —o
cuando alguien edita a mano el fichero dentro del contenedor— lo que hay en disco deja de coincidir
con la expectativa que el gateway registró para la generación viva. El alias sigue trabajando, con
un contexto que nadie autorizó, y la consola lo pinta como `drifted` sin ofrecer remedio: la única
salida era volver a guardar el perfil desde Contexto, que **sube la revisión** y ensucia el
histórico con versiones que no cambiaron nada.

## Decisión

**Detectar, poner en cuarentena, auditar y medir. Y dar una recarga explícita como remedio.**

### La guardia

`services/gateway/src/console/contaminacion-de-contexto.ts` es una función pura,
`evaluarContaminacion(medido, esperado)`, que devuelve un veredicto tipado a partir de dos hechos y
de ninguna opinión:

1. **`foreign_managed_block`** — un bloque gestionado cuyo renglón de dueño nombra a otro alias.
2. **`expectation_sha_mismatch`** — un fichero de gobierno cuya huella medida no coincide con la de
   la expectativa registrada **para la generación que está viva ahora mismo**.

Ese amarre a la generación viva es la parte que hay que leer despacio. Una expectativa registrada
contra una generación anterior que no coincide **no es contaminación**: es deriva ordinaria, y es
exactamente lo que una recarga arregla. Tratarla como contaminación pondría en cuarentena el
remedio y dejaría al alias atascado para siempre.

El veredicto **nombra al alias dueño del bloque intruso y nunca un byte de lo que el bloque dice**.
Viaja a un cuerpo HTTP y a una fila de auditoría, y en ninguno de los dos puede aparecer prosa del
contenedor de nadie. La guardia tampoco juzga la propiedad de un texto que no pudo leer entero: un
prefijo truncado entra con `text: null` y no produce veredicto, porque afirmar propiedad desde un
prefijo es afirmar de más.

### La cuarentena

**Sin tabla nueva.** Un veredicto contaminado hace que el gateway **rechace la escritura y la
recarga** con un `409` tipado (`context_contaminated`) que lleva el motivo y el alias dueño, emita
una fila de auditoría de denegación, y sume un contador expuesto en `/metrics` como
`cauce_gateway_context_contamination_total{reason}`.

**Dónde está cableada hoy, exactamente.** En las tres vías por las que Cauce reescribe el `$HOME`
de un alias: la recarga (`agent-context-reload.routes.ts`), la escritura manual de un documento de
gobierno (`agent-documents.routes.ts`, el `PUT` de contenido) y el `PUT` del perfil
(`agent-profile.routes.ts`). Las tres exigen además una persona atribuida y un motivo escrito a
mano con los mismos topes, y las tres dejan fila de auditoría tanto si aceptan como si niegan.

**En el PUT del perfil la guardia corre ANTES de proyectar**, no después. Es la diferencia con la
recarga: allí la negativa del preflight se vuelve a juzgar porque el veredicto se calcula tarde;
aquí el contexto se mide antes de llamar a `prepareAgentProfileRuntime`, así que el bloque ajeno se
contesta con dueño, veredicto y contador sin pasar nunca por el `409 conflict` seco del generador,
y `replaceProfile` no llega a ejecutarse. El orden completo de las compuertas del `PUT` es el mismo
que el del documento: destino → persona → alias encendido → cuerpo → CAS → contaminación.

**En la recarga, la negativa del preflight se vuelve a juzgar.** `prepareAgentProfileRuntime` ya se
niega ante un bloque ajeno, y lo hace ANTES de devolver nada: lanza un `conflict` seco que no lleva
los bytes con los que se sabe de quién es el bloque. Si el veredicto se calculara sólo después de
`materialize`, el caso principal de esta ADR sería inalcanzable y su contador no podría subir nunca.
La recarga proyecta antes de juzgar, así que atrapa ese `conflict`, vuelve a medir los ficheros y
deja que la guardia diga de quién es;
sólo esa negativa paga la segunda lectura, y una carrera que borre el bloque entre medias vuelve al
`conflict` genérico en vez de inventar un veredicto. El contador es un singleton de proceso leído
directamente por `health.ts`: pasarlo por las opciones del gateway dejaría el incremento y el
scrape en dos objetos que sólo coinciden mientras alguien se acuerde de darles la misma instancia.
Sólo viaja el motivo — ni tenant, ni alias, ni ruta, ni digest llegan a Prometheus.

Se descartó una tabla de cuarentena porque no hay nada que **guardar**: el hecho es del disco del
contenedor, se vuelve a medir en cada petición, y una fila durable sólo añadiría un estado que
alguien tendría que acordarse de limpiar y que envejecería peor que la medición.

### La recarga

`POST /v3/console/tenants/:tenantId/agents/:alias/context/reload`, y su hermana sin tenant
`POST /v3/console/agents/:alias/context/reload`. Fuerza la re-materialización: relee el perfil
durable y los hechos **medidos**, proyecta, corre la guardia **antes** de tocar nada, escribe el
lote gobernado con el CAS por fichero **reusando el camino canónico del PUT** —el mismo preflight,
el mismo `materialize`, el mismo `apply` que relee y revalida la generación—, vuelve a medir,
registra la expectativa y devuelve un resultado tipado con el vocabulario de
`context-apply-policy.ts`.

Tres cosas que la recarga **no** hace, y son decisiones, no omisiones:

- **No reinicia la TUI ni abre una shell.** Reiniciar una TUI viva destruye la conversación de su
  dueño; eso es terreno del dueño y de nadie más. Por eso el estado que devuelve un éxito es
  `pending_session_refresh` y nunca `applied`: el lote acredita **bytes en disco** y nada más. Que
  el proceso los esté leyendo sólo lo dice el ACK de adopción del adaptador, que llega en su
  siguiente entrega.
- **No sube la revisión del perfil.** Re-materializa exactamente la revisión durable vigente. Una
  recarga repara disco, no autoría, y no puede saltarse el CAS del PUT porque no escribe la fila.
- **No corre con una entrega en vuelo.** Falla cerrada con `delivery_in_flight` y lo dice en el
  cuerpo: reescribir los ficheros de gobierno mientras un turno ya empezó cambiaría el contexto por
  debajo de ese turno.

### Dos llamantes, dos compuertas

Esta es la distinción que hay que documentar porque no es obvia:

- **Un operador recargando el alias de otro** hace el mismo acto de autoridad que escribirle en su
  `$HOME`. Lleva permiso `control`, **una persona atribuida** (`resolveOperator`, la misma vía que
  W3B-08 impuso a las escrituras de gobierno) y **un motivo escrito a mano** de entre 8 y 280
  caracteres, los mismos topes que aplica el plano PTY. Sin persona: `403`
  `writable_requires_attribution`, y fila de auditoría.
- **Un alias recargándose a sí mismo** se autentica como sí mismo por mTLS —es lo que hace el
  adaptador en `packages/adapter-sdk/src/context/native-profile-context.ts` cuando encuentra su
  contrato rancio— y **no lleva persona ni motivo, porque no hay ninguna que nombrar**. Lleva
  permiso `read` y la forma sin tenant, que sólo puede significar su propio tenant; un actor que
  llegue a esa forma pidiendo por otro alias recibe `403 self_reload_only`.

Las dos salidas se auditan, y la fila dice cuál de las dos fue (`principal: operator` o
`principal: alias_self`, con `attributed` en claro). Una recarga que no dejara fila sería peor que
una ruta caída: sería una reescritura de la casa de alguien sin acusado.

### El diario (`041`)

La migración `041` añade `agent_profile_revisions` —escrita por un trigger `AFTER INSERT OR UPDATE
OR DELETE` sobre `agent_profiles`, para que la **creación** del perfil también quede anotada— y
`agent_document_revisions`, que guarda **huella y metadatos, nunca cuerpo**. Ninguna de las dos
tiene foreign key a `agents`: un `ON DELETE CASCADE` se llevaría por delante exactamente la prueba
que el diario existe para conservar.

**Quién impone qué.** Que ninguna columna pueda contener un cuerpo lo sostiene la BASE: `sha256` o
es NULL o es un digest canónico de 64 hex, y `bytes` es un entero no negativo. De `path` la base
sólo exige la barra inicial y una longitud de 2 a 4096, así que la FORMA de la ruta —absoluta, sin
`..` ni segmentos vacíos, acotada— la impone el ESCRITOR, `recordDocumentRevision` del store, que
es el único que inserta en esa tabla.

**Una fila por TIPO de documento, y sólo de lo reescrito.** El `kind` de cada fila es el mismo
vocabulario que sirve la ruta de historial (`directive`, `tools`, `identity`…), no la categoría del
lote: una fila anotada bajo una categoría que el lector no acepta es una fila que nadie puede leer,
y el diario entero sería de sólo escritura. Un fichero que el lote se limitó a **verificar**
(`MEMORY.md` y `HEARTBEAT.md` de openclaw, que son del agente) no deja fila: anotarlo diría que la
recarga lo reescribió, que es justo lo que este camino promete no hacer.

**El actor del diario del perfil es NULL, y eso hoy significa «no consta» siempre.** El trigger lee
`cauce.actor_tenant` / `cauce.actor_alias`, y en el árbol **nadie** emite ese `SET LOCAL`: quien
escribe `agent_profiles` es `AgentProfileStore.replace`, que no lo hace. **Se mantiene esa decisión
aun con el PUT ya guardado**: emitir el `SET LOCAL` obliga a entrar en la transacción del store, y
lo que se ganaría —el nombre del actor— ya está en dos filas de `audit_events` que sí lo dicen y
que además dicen el porqué: la `agent_profile.desired` que escribe el propio store y la
`agent_profile.write` que escribe el gateway, con la persona atribuida, su motivo escrito a mano,
la revisión y el tamaño serializado del perfil (nunca el contenido de ningún campo). El diario
sigue siendo la prueba de QUÉ huella quedó; quién la puso se pregunta a la auditoría.

## Consecuencias

- Los dos casos conocidos de la flota dejan de ser latentes por las tres vías cableadas: un alias
  que se recargue sobre el `.claude` compartido de otro, una persona que guarde ahí un documento de
  gobierno a mano, o una que guarde ahí el perfil desde Contexto, reciben `409 context_contaminated`
  con el nombre del dueño en un campo estructurado, fila de auditoría y contador.
- El `GET` del perfil lleva SIEMPRE el veredicto (`contaminacion`), también limpio y también para
  una sesión sin persona: leer nunca exigió atribución, y una pantalla que sólo muestra la
  cuarentena cuando algo falla obliga a intentar guardar para enterarse.
- La deriva tiene remedio sin ensuciar el histórico: la recarga re-materializa la revisión vigente
  en vez de crear una nueva que no cambió ningún campo.
- El adaptador puede curarse solo. Eso es una ruta de escritura que se dispara **sin persona**, y
  hay que verla como lo que es: acotada al propio alias, autenticada por su certificado, incapaz de
  cambiar el perfil durable, auditada, y sujeta a la misma guardia y a la misma compuerta de entrega
  en vuelo que la del operador.
- `/metrics` gana un contador que cuenta cuarentenas por motivo. Que suba no dice qué contenedor,
  y a propósito: el motivo basta para saber que hay que mirar, y la fila de auditoría dice dónde.
- El estado `applied` sigue exigiendo el ACK de adopción. Una recarga nunca lo produce, y esta ADR
  se niega a que lo produzca: si un éxito de recarga dijera `applied`, la pantalla afirmaría que el
  proceso lee algo que nadie comprobó que lea.

## Fuera de alcance, dicho explícitamente

- **Reiniciar arneses.** Ni esta ADR ni la recarga tocan un proceso vivo. Que un alias adopte el
  contexto nuevo depende de su siguiente turno, y forzarlo es del dueño.
- **Encender el flag de contexto nativo.** `CAUCE_NATIVE_PROFILE_CONTEXT` sigue decidiéndose por
  alias y fuera de aquí.
- **Detectar dos alias que resuelven al MISMO inodo.** Es un hecho de disco —hace falta comparar
  `st_dev`/`st_ino` desde dentro de los dos contenedores— y no se puede deducir del texto de los
  ficheros. Va en W5-O4, no aquí. Mientras tanto la guardia atrapa el síntoma (el bloque ajeno),
  no la causa (el montaje compartido).
- **El `SET LOCAL` del actor en la transacción del perfil.** Sigue sin emitirse, y se explica arriba
  por qué: el nombre y el motivo viven en `audit_events`, no en el diario.
- **Poda de retención del diario.** `agent_document_revisions` guarda huellas, no cuerpos, y por eso
  crece despacio; cuándo podarlo es una decisión de coste que es del dueño y todavía no está tomada.
