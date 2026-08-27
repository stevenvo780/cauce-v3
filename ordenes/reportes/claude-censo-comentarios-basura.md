# Censo de comentarios y basura v2 (27-08) — mapa quirúrgico

**Totales: 2322 líneas de comentario borrables (localizadas por fichero abajo) · 11 ítems de basura (ejecutados por el integrador salvo los ya asignados).**

Matiz clave del censo: la MAYORÍA de la densidad de comentarios es invariante legítimo (contratos de wire, locking, seguridad). La limpieza correcta es quirúrgica con estas tablas, NO otra pasada masiva. Clases: narrativo/mutilado/ceremonial = borrar; invariante = conservar (compactar si es largo); sql-string = NO tocar sin verificar bytes.

## Comentarios — packages/store/src (incl. repository/**), packages/protocol/src, packages/mcp-fleet-monitor/src

ZONA COMPLETA (36 ficheros .ts, store+protocol+mcp-fleet-monitor): 17.507 líneas de código, 2.217 líneas de comentario (12,7% global). mcp-fleet-monitor/src NO aporta ningún fichero a la tabla: su máximo es fleet-read-model.ts con 14 líneas/3,3% — paquete limpio, muy por debajo de cualquier umbral. Los 21 ficheros que cruzan el umbral (>30 líneas O >15% densidad; ningún test supera el 25% exigido, así que los 3 tests de la zona quedan fuera) concentran 2.055 de esas líneas de comentario. Estimación honesta de borrables en esos 21 ficheros: 636 líneas (≈31% de sus comentarios, ≈29% del total de la zona) — narrativo, mutilado o ceremonial que se puede eliminar sin perder ninguna restricción real; el resto es en su mayoría invariante legítimo (contratos de wire, locking, seguridad multi-tenant, idempotencia) que sí debe conservarse, aunque muchos bloques siguen siendo más largos de lo necesario para el hecho que protegen.

Hallazgo directo de mutilación mecánica: en deliveries.ts, dentro de lateTerminalSalvage(), quedan seis comentarios huérfanos "// S1" "// S2" "// S3" "// S4" "// S5" "// S6" sin ninguna definición de qué es cada condición — es exactamente el patrón que describe el dueño: la limpieza masiva (2a22107) dejó fragmentos rotos. Patrón narrativo recurrente: varios ficheros narran el MISMO incidente con cifras medidas ("71 en vuelo", "881 entregas", "197 entregas de producción", "148 repeticiones", "88%/61%/90% medido en prod") en vez de declarar solo la regla; el caso de "197 entregas" aparece duplicado casi textual en deliveries.ts Y en outbox.ts. Hallazgo sql-string: fanin.ts líneas 987-991 tiene un bloque de 5 líneas de comentario `--` DENTRO de un template literal SQL real (no contado en el recuento de líneas de comentario JS/TS de la tabla) — no tocar sin verificar que no cambia bytes que via jan a Postgres.

3 PEORES FICHEROS: (1) packages/store/src/repository/deliveries.ts — 294 líneas de comentario, 118 borrables (40%): mezcla narrativo (varios incidentes con cifras) y la evidencia más clara de mutilación (S1..S6 huérfanos). (2) packages/store/src/agent-profile.ts — 51 líneas, 35 borrables (69%): dominado por JSDoc ceremonial que repite el nombre de cada función/campo sin añadir ninguna restricción. (3) packages/protocol/src/marcas-de-bloque.ts — 17 líneas, 10 borrables (59%): mismo patrón ceremonial, casi cada comentario es "Inserta X", "Extrae Y", "Quita Z" calcado del nombre de la función.

Contraejemplos positivos (para no sobre-corregir): packages/protocol/src/priority.ts, packages/store/src/repository/agents/notifications.ts, packages/store/src/repository/messages.ts, packages/store/src/db.ts y packages/protocol/src/publish-receipt.ts son casi enteramente invariante bien dirigido (límites reales, contratos de idempotencia, quirks documentados del driver pg) con muy poco que borrar — la densidad alta por sí sola NO implica ruido.

| Fichero | Coment. | % | Borrables | Clase | Ejemplo |
|---|---|---|---|---|---|
| `packages/store/src/repository/deliveries.ts` | 294 | 20% | **118** | mixto | // S1 ... // S6 (etiquetas huérfanas sin definición, dentro de lateTerminalSalvage) + "el número que explotó e |
| `packages/protocol/src/schemas.ts` | 243 | 22% | **57** | invariante | "un adaptador de una imagen anterior RECHAZARÍA el sobre entero si el store le mandara un campo que no conoce" |
| `packages/store/src/repository/observability/policy.ts` | 129 | 61% | **55** | invariante | "DISPOSABLE_AUDIT_ACTIONS... es la decisión más importante de todo el barrido" — límites y ventanas de retenci |
| `packages/store/src/repository/agents/fanin.ts` | 182 | 13% | **54** | invariante | sql-string aparte: líneas 987-991 son un comentario `--` de 5 líneas DENTRO del template literal SQL (no conta |
| `packages/store/src/repository/agents/chain-control.ts` | 214 | 16% | **50** | invariante | "de ahí las 148 repeticiones de una misma arista medidas en prod" (estadística narrativa incrustada en explica |
| `packages/store/src/repository/observability.ts` | 220 | 15% | **46** | invariante | "881 entregas se murieron así, sin un solo audit_events... eso es lo que hizo invisible la fuga durante semana |
| `packages/protocol/src/agent-profile.ts` | 69 | 21% | **41** | ceremonial | /** Rol declarado del agente. */ — repite el nombre del campo sin aportar restricción alguna |
| `packages/store/src/agent-profile.ts` | 51 | 10% | **35** | ceremonial | /** Convierte una fila de la base de datos al tipo `AgentProfile`. */ — JSDoc que solo repite la firma |
| `packages/store/src/repository/deliveries/control.ts` | 65 | 32% | **30** | invariante | "NO INVENTA UN ESTADO NUEVO... toda la maquinaria de revisión manual ya apunta ahí" — bloques largos pero just |
| `packages/store/src/repository/quotas.ts` | 106 | 15% | **26** | invariante | "no había ni una muestra en 72 h con el recolector corriendo" — narra un bug de ON CONFLICT ya corregido en ve |
| `packages/store/src/repository/outbox.ts` | 71 | 6% | **25** | invariante | "197 entregas de producción quedaron sin botón de rescate" — mismo incidente narrado casi textual en deliverie |
| `packages/store/src/configuration.ts` | 85 | 7% | **18** | invariante | "una columna que no se lea aquí vuelve como ausente y el deshacer la deja en su valor por defecto" — invariant |
| `packages/store/src/repository/messages.ts` | 47 | 4% | **15** | invariante | "A stored JSON receipt is only an optimization... a consistency witness" — idempotencia de publicación bien do |
| `packages/store/src/repository/agents/notifications.ts` | 74 | 14% | **12** | invariante | "Every step is default-deny... it never throws for a policy decision" — motor de autorización numerado 1-7, ca |
| `packages/protocol/src/ficheros-del-arnes.ts` | 41 | 17% | **12** | mixto | "MEMORY.md y HEARTBEAT.md... son gestionados por el agente" repetido casi textual 4 veces en el mismo fichero |
| `packages/store/src/accounts.ts` | 53 | 18% | **10** | invariante | "El orden de los chequeos ES la semántica y no es intercambiable" — fichero ajustado, poco que borrar |
| `packages/store/src/db.ts` | 44 | 10% | **10** | invariante | "node-postgres does not expose hard socket cancellation on PoolClient's public type" — quirks reales del drive |
| `packages/protocol/src/marcas-de-bloque.ts` | 17 | 18% | **10** | ceremonial | /** Quita un bloque delimitado por marcas conservando el resto del contenido. */ — calco del nombre de removeB |
| `packages/protocol/src/publish-receipt.ts` | 29 | 19% | **8** | invariante | "Do not add domain separation... would turn every valid pre-upgrade retry into a 409" — contrato de idempotenc |
| `packages/protocol/src/priority.ts` | 15 | 50% | **2** | invariante | "Agent band -100..50 / Reserved gap 51..59 / Human band 60..100" — mejor ejemplo de la zona: alta densidad, ca |
| `packages/store/src/migrate-cli.ts` | 6 | 19% | **2** | invariante | "reject every ambiguous direct entrypoint... before reading DATABASE_URL" — gate operacional real, algo verbos |

## Comentarios — services/gateway/src, services/terminal-relay/src, services/telegram-bridge/src, services/dispatcher/src

38 ficheros de la zona superan el umbral (>30 líneas de comentario o >15% densidad); dispatcher/src no aportó ninguno (su peor fichero, config.ts, sólo llega a 16 líneas/11%). Total: 2251 líneas de comentario sobre 15361 líneas de código en esos 38 ficheros = 14.7% de densidad conjunta. Estimación honesta de borrables: ~192 líneas (8.5% de las líneas de comentario, ~1.3% del código total) — MUY por debajo de lo que la sensación de "demasiado ruido" sugeriría. Grep dirigido no encontró fechas AAAA-MM-DD, ni TODO/FIXME/XXX, ni comentarios SQL con "--" dentro de template literals en toda la zona (categoría sql-string: 0 hallazgos; ficheros con SQL como session-control.ts y authority.ts no tienen comentarios dentro de los strings). Sólo se detectó UN caso claro de mutilación mecánica real: dos bloques JSDoc apilados y redundantes sobre la misma función en gateway/src/terminal/tickets.ts (verifyTicketSignature, líneas 158-162) — resto de la zona sin evidencia de frases mutiladas (ni sujetos comidos ni markdown huérfano). El narrativo real es puntual, no sistémico, y se concentra en 8 ficheros "mixto": citas de personas reales usadas como ejemplo (Miguel; Miguel/Pablo/Isa) en terminal/authority.ts y terminal/governance-probes.ts, una referencia a incidente por mes ("la discrepancia de agosto") en console/agent-profile.routes.ts, un bloque completo de historia de bug ("EL CONTENIDO — las dos rutas que la consola llamaba y el servidor NO SERVÍA") en console/agent-documents.routes.ts, y varios "antes X no lo hacía / éste es el defecto que esto arregla" narrados como cuento dentro de routes/core.ts. Los 3 peores ficheros por líneas borrables absolutas: routes/core.ts (20 de 202), console/agent-documents.routes.ts (18 de 101) y console/agent-profile.routes.ts (10 de 65); en proporción, terminal/governance-probes.ts es el más contaminado (6 de 29 = 21%). Los otros 30 ficheros son dominantemente [invariante] de alta calidad: invariantes de concurrencia (fencing de ACKs, control de admisión), invariantes de seguridad (timing attacks, redacción de secretos, verificación de rutas contra symlinks, CSRF, alg:none en JWT), contratos de wire binario compartidos entre TypeScript/Python, y tablas de precedencia — el dueño puede confiar en que esa densidad restante no es narrativa vacía sino restricción real que el código no puede expresar por sí solo.

| Fichero | Coment. | % | Borrables | Clase | Ejemplo |
|---|---|---|---|---|---|
| `services/gateway/src/routes/core.ts` | 202 | 14% | **20** | mixto | 'retry' TIENE que liberar el cupo, y no lo hacía... el mismo modo de falla que este parche existe para evitar  |
| `services/gateway/src/console/agent-documents.routes.ts` | 101 | 16% | **18** | mixto | EL CONTENIDO — las dos rutas que la consola llamaba y el servidor NO SERVÍA (bloque entero narrado como histor |
| `services/telegram-bridge/src/egress.ts` | 112 | 17% | **12** | invariante | El texto se hashea EXACTAMENTE como antes de que existieran los adjuntos... es lo que hace que este cambio se  |
| `services/telegram-bridge/src/ingress-body.ts` | 105 | 30% | **10** | invariante | body.untrusted_context used to hold this information and was never rendered... the sanitiser guarded a field n |
| `services/gateway/src/console/agent-profile.routes.ts` | 65 | 9% | **10** | mixto | dos cuentas del mismo número son dos sitios donde discrepar, y la discrepancia de agosto dejó un alias sordo ( |
| `services/gateway/src/console/agent-documents.ts` | 135 | 12% | **8** | invariante | Falla cerrada. La consulta es parte del fence de reconexión: inventar un mapa vacío ante un error permite mult |
| `services/telegram-bridge/src/config.ts` | 66 | 16% | **8** | invariante | This used to throw at boot, which turned the documented per-alias rollback into a crash loop that took every D |
| `services/gateway/src/terminal/authority.ts` | 63 | 20% | **8** | mixto | A shell in ws-humanizar sees the home of Miguel's three agents (cita de persona real como ejemplo, dentro de u |
| `services/telegram-bridge/src/poller.ts` | 86 | 17% | **6** | invariante | El orden importa: un mensaje anónimo TAMBIÉN falla el allowlist de usuario... si se preguntara primero por el  |
| `services/telegram-bridge/src/redaction.ts` | 66 | 30% | **6** | invariante | esa lista se queda vieja el día que alguien agrega un campo nuevo —pasó con prompt, que nació mucho después qu |
| `services/gateway/src/terminal/tickets.ts` | 36 | 12% | **6** | mixto | dos bloques JSDoc apilados y redundantes sobre verifyTicketSignature (líneas 158-162), resto del fichero es co |
| `services/gateway/src/terminal/governance-probes.ts` | 29 | 24% | **6** | mixto | la flota visible mostraba el cajón de Miguel/Pablo/Isa pero su directiva contestaba 403 (cita de tres personas |
| `services/gateway/src/routes/console.ts` | 73 | 8% | **5** | invariante | not_found y NO forbidden: responder «prohibido» confirmaría que el mensaje existe a quien no puede verlo |
| `services/gateway/src/console/agent-directive.routes.ts` | 57 | 14% | **5** | invariante | SEGURIDAD CRÍTICA: estas políticas se implementan TANTO en el gateway como en el pty-agent. Una falla en CUALQ |
| `services/telegram-bridge/src/untrusted.ts` | 91 | 43% | **4** | invariante | Tabla CONFUSABLE_TABLE anotada carácter por carácter (CYRILLIC A / GREEK ALPHA / LATIN ALPHA...); dato de segu |
| `services/telegram-bridge/src/types.ts` | 71 | 20% | **4** | invariante | It is derived, never configured: the poller only reaches here after accepted() matched allowed_user_ids |
| `services/terminal-relay/src/governance-relay.ts` | 65 | 11% | **4** | invariante | Lo que este módulo NO decide / Lo que sí decide: especificación de responsabilidades clara, casi nada borrable |
| `services/telegram-bridge/src/artifacts.ts` | 55 | 22% | **4** | invariante | No tira nunca. Cualquier forma inesperada termina en discarded o en una línea del pie |
| `services/gateway/src/terminal/plugin.ts` | 42 | 13% | **4** | invariante | Topología: gateway/console/PostgreSQL en agora-storage, los catorce contenedores de agente en kratos; cruce ob |
| `services/telegram-bridge/src/main.ts` | 29 | 17% | **4** | invariante | An earlier version threw on both of the conditions below... turned into a crash loop that took every DM down w |
| `services/gateway/src/console/types-agent-directive.ts` | 22 | 28% | **4** | invariante | SHA-256 real; permite detectar contenido duplicado entre niveles sin comparar texto truncado |
| `services/telegram-bridge/src/addressing.ts` | 137 | 37% | **3** | invariante | Tabla de precedencia P0.a..P10 con justificación de cada regla; ejemplar, casi nada borrable |
| `services/gateway/src/password-auth.ts` | 81 | 16% | **3** | invariante | UN SOLO MENSAJE para las tres formas de fallar... y el MISMO trabajo criptográfico en todos los casos (defensa |
| `services/terminal-relay/src/agent-hello.ts` | 45 | 13% | **3** | invariante | A diferencia de modesField, esto NO invalida el hello: un agente viejo no manda features y tiene que seguir en |
| `services/telegram-bridge/src/attachments.ts` | 41 | 14% | **3** | invariante | Buffer.from ignora en silencio lo que no es base64: sin esta comprobación, un adjunto corrupto se subiría trun |
| `services/gateway/src/app.ts` | 35 | 9% | **3** | invariante | Control de admisión por sesión. Ver DeliveryAdmissionConfig y drain() |
| `services/gateway/src/terminal/types.ts` | 35 | 24% | **3** | invariante | PostgreSQL bigint stays a decimal string on the wire; never coerce the fence to Number |
| `services/telegram-bridge/src/markdown.ts` | 28 | 23% | **3** | invariante | 9. Énfasis. El negrita va antes que la itálica para que ** no se lea como dos * (justificación de orden del pi |
| `services/terminal-relay/src/agent-connection.ts` | 45 | 8% | **2** | invariante | CLOSE may not be silently discarded behind PTY/data traffic; a small reserved tail accepts every close |
| `services/gateway/src/terminal/session-control.ts` | 43 | 5% | **2** | invariante | Authority and reachability are independent. An authorized destination can still be offline, not installed or u |
| `services/terminal-relay/src/browser-leg.ts` | 34 | 7% | **2** | invariante | The browser never reaches this listener: the console nginx terminates the user connection and re-dials with a  |
| `services/terminal-relay/src/governance-read.ts` | 34 | 7% | **2** | invariante | A 65.500 B por trama, 256 KB entran en 5. Se admiten 8 por holgura: más tramas anunciadas no es un documento g |
| `services/terminal-relay/src/framing.ts` | 29 | 18% | **2** | invariante | no field order, padding or encoding may change without changing the agent and the interop golden vectors toget |
| `services/gateway/src/terminal/config.ts` | 29 | 16% | **2** | invariante | Default relay contract: 30s authz + 90s grace + 5s HTTP + 5s takeover margin, strictly exceeded |
| `services/gateway/src/console/sonda-compartida.ts` | 24 | 19% | **2** | invariante | Sonda degradada: contesta con la verdad —que nadie ha medido— en vez de lanzar |
| `services/gateway/src/password.ts` | 25 | 18% | **1** | invariante | N=2^15 con r=8 son ~33 MB por verificación: caro para una GPU, imperceptible en un login |
| `services/gateway/src/publish-priority-policy.ts` | 8 | 17% | **0** | invariante | An operator role grants control operations; it does not prove that a person originated a message |
| `services/terminal-relay/src/log.ts` | 7 | 32% | **0** | invariante | Certificate fingerprints are correlation handles, not secrets, but 16 hex is plenty |

## Comentarios — apps/console/src y packages/adapter-sdk/src (cauce-v3) — censo de comentarios, sin modificar nada

ZONA CENSADA: 122 ficheros (103 fuente + 19 test que superan 25% de densidad) de apps/console/src y packages/adapter-sdk/src, sobre 36.526 líneas totales. TOTALES: 7.567 líneas de comentario en estos 122 ficheros (20,7% de densidad media dentro de la zona marcada; 15,1% sobre el total de la zona, 10.217/67.592). Estimación honesta de borrables: ~1.413 líneas (18,7% de las líneas de comentario de la zona marcada) — bastante menos de lo que "demasiado ruido" sugiere, porque el grueso de la densidad NO es cuento vacío: son 66/122 ficheros de clase INVARIANTE dominante (contratos de tipos, semántica de null/UNKNOWN, reglas de concurrencia/seguridad de ficheros) con muy poco recortable (5-15%). El ruido real está concentrado: 10 ficheros son NARRATIVO dominante — casi todos tests de legibilidad/CSS que narran una medición histórica en Chrome con cifras, fecha y a veces cita textual del dueño ("MEDIDO en Chrome...", "Steven, por SEGUNDA vez..."), donde 45-65% de sus líneas de comentario son prescindibles sin tocar el guardia real. Otros 46 ficheros son MIXTO: la regla es real pero está envuelta en un "antes se llamaba X / ahora Y", con fecha y cifra de incidente, que podría comprimirse a una línea por fichero (tal como pide el protocolo). CLASE "ceremonial" (JSDoc/@param): AUSENTE — 0 coincidencias de @param/@returns en toda la zona; esta base de código nunca usó ese estilo. CLASE "sql-string": NO APLICA en esta zona — no hay strings SQL con comentarios embebidos en apps/console/src ni packages/adapter-sdk/src (ese patrón, si existe, vive en packages/store, fuera del alcance pedido). HALLAZGO SEPARADO — MUTILADO REAL Y CONCRETO: confirmé al menos 15-17 fragmentos rotos dejados por la limpieza mecánica (commit 2a22107) en al menos 15 ficheros distintos, con dos firmas reconocibles: (a) un "**" de negrita huérfano seguido de doble espacio y texto en minúscula que empieza a mitad de frase (p.ej. agent-state.ts:535 "*  el veredicto decía...", denegaciones.ts:4 "Steven,  pedir una sesión PTY...", quotas.ts:154 "...misma línea.**  la tarjeta de codex..."); (b) un título o frase que quedó truncado a secas (capas-pendientes.ts:4 "LO QUE " sin nada más; deriva.ts:16 "Por qué existe este módulo.** " seguido de texto sin sujeto). Estos no son mayoría de ningún fichero (por eso ninguna fila usa "mutilado" como clase_dominante) pero son evidencia dura de que la limpieza anterior sí rompió frases, tal como sospecha el dueño. TRES PEORES FICHEROS por volumen absoluto de borrable: (1) apps/console/src/features/config/config-css.test.ts — 246 líneas de comentario, 35% densidad, ~160 borrables (narrativo: 8 repeticiones de "MEDIDO en Chrome" con cifras de contraste WCAG y una cita textual del dueño); (2) apps/console/src/styles.tipografia.test.ts — 134 líneas, 37% densidad, ~87 borrables (narrativo: tabla de medición por vista con fecha); (3) apps/console/src/features/live/agent-state.ts — 268 líneas, 31% densidad, ~75 borrables (mixto: el fichero con más comentario de toda la zona; mezcla reglas de estado reales de alto valor con largos "antes se llamaba X, decía Y" narrados como historia, más dos fragmentos mutilados confirmados).

| Fichero | Coment. | % | Borrables | Clase | Ejemplo |
|---|---|---|---|---|---|
| `apps/console/src/features/config/config-css.test.ts` | 246 | 35% | **160** | narrativo | cita «Steven, por SEGUNDA vez: «la vista de configuraciones...»»; «MEDIDO en Chrome contra el snapshot real de |
| `apps/console/src/styles.tipografia.test.ts` | 134 | 37% | **87** | narrativo | «El arreglo de legibilidad de 2026-08-24... MEDIDO por mí en Chrome de verdad» + tabla de cifras por vista, re |
| `apps/console/src/features/live/agent-state.ts` | 268 | 31% | **75** | mixto | «Los siete estados que  cada uno con su muñeco» (mutilado, doble espacio) y «*  el veredicto decía «13 conecta |
| `apps/console/src/styles.tipografia-montada.test.tsx` | 91 | 34% | **55** | narrativo | «EL SUELO TIPOGRÁFICO... MEDIDO acá, no supuesto» y cifras de medición en Chrome/jsdom |
| `apps/console/src/features/live/LiveFleetPage.tsx` | 186 | 22% | **46** | mixto | bloques narrativos largos «Antes el mapa recibía... La cabecera decía...» y fecha 2026-08-23 mezclados con reg |
| `apps/console/src/features/live/tira-de-pestanas.test.ts` | 59 | 52% | **35** | narrativo | «...cajón abierto en `/live?agente=Steven/zeus...» (mutilado); tabla de píxeles medidos en Chrome, relato de m |
| `apps/console/src/api/types.ts` | 230 | 19% | **34** | mixto | bloque «LAS TRES CAPAS DE DIRECTIVA... Medido sobre producción el 23-ago-2026» narrativo; el resto son docs de |
| `apps/console/src/api/use-resource.fallo-visible.test.tsx` | 57 | 33% | **26** | narrativo | «Este fichero existe porque mis propias pruebas dieron VERDE... 30 s clavados, medido sobre el build de produc |
| `apps/console/src/features/config/collection-table.ts` | 124 | 42% | **25** | mixto | «...columna de la base.**  las tablas mostraban...» (mutilado, ** huérfano); resto es regla de UI real |
| `apps/console/src/features/live/perfil-css.test.ts` | 44 | 42% | **24** | narrativo | «El editor de perfil no cabía en el cajón, y jsdom no lo puede ver.**  claro, alias con arnés `openclaw`...» ( |
| `packages/adapter-sdk/src/harnesses/shared.ts` | 261 | 23% | **21** | invariante | documenta el contrato del sobre y por qué el sello es un resumen; denso pero sustantivo |
| `apps/console/src/mocks/data.ts` | 173 | 20% | **21** | mixto | fixtures anotados con «por qué» reales; algunas referencias a Steven/incidentes son narrativas pero cortas |
| `apps/console/src/vocabulario.test.tsx` | 41 | 39% | **21** | narrativo | «los 646 tests de esta consola pasaban con todos estos defectos delante»; enumera 4 defectos medidos con cifra |
| `apps/console/src/features/terminal/denegaciones.ts` | 81 | 31% | **20** | mixto | «Steven,  pedir una sesión PTY...» (mutilado) y «...403 en 3 de 3 intentos, en dos alias...» (mutilado, arranc |
| `apps/console/src/features/terminal/api.ts` | 95 | 13% | **19** | mixto | «LA COPIA SE HABÍA DESVIADO... Resultado medido contra producción el 2026-08-23: ... 403 ... 3 de 3» — inciden |
| `apps/console/src/features/config/areas.test.ts` | 62 | 41% | **19** | mixto | «ARREGLADO el 2026-08-25» y «MEDIDO en Chrome sobre /config: entre el título...»; resto son CONTROL NEGATIVO r |
| `apps/console/src/features/live/directiva.ts` | 82 | 27% | **18** | mixto | fecha «23-ago-2026»; «Lo que  es que la MISMA regla...» (mutilado, texto perdido tras «Lo que») |
| `apps/console/src/features/landing/landing.ts` | 64 | 26% | **18** | mixto | «La portada gastaba la primera pantalla entera en avisos.**  1280×900:...» (mutilado); fecha 2026-08-22 |
| `apps/console/src/features/topology/hypergraph-layout.ts` | 216 | 23% | **17** | invariante | explica por qué cada fórmula geométrica es así (áreas, bisectrices); documentación de diseño legítima |
| `apps/console/src/features/config/ConfigPage.tsx` | 133 | 20% | **16** | invariante | explica por qué cada guard existe; poco narrativo puro |
| `apps/console/src/features/terminal/fleet.ts` | 80 | 21% | **16** | mixto | «La vista rompía su propia promesa. **» (** huérfano, mutilado) + «Por qué «3 / 6» estaba mal.** Medido en pro |
| `apps/console/src/features/config/areas.ts` | 65 | 38% | **16** | mixto | cita del dueño «pestañas, botones amigables, toggles, tooltips»; «ARREGLADO el 2026-08-25» con fecha |
| `apps/console/src/api/client.timeout.test.ts` | 35 | 28% | **16** | narrativo | «//consola.humanizar.tech/live`, con la máquina del gateway al 89,9% de steal time: 180 segundos» |
| `apps/console/src/features/live/deriva.ts` | 53 | 55% | **15** | mixto | «Por qué existe este módulo.**  `LiveFleetPage` con un comentario que afirmaba...» (mutilado); narra el incide |
| `apps/console/src/features/config/interruptores.ts` | 71 | 29% | **14** | mixto | «Lo que había: ... Veinticuatro botones... Medido en Chrome» y cita del dueño «esto se resolvía fácil con togg |
| `apps/console/src/features/config/Interruptor.tsx` | 62 | 33% | **14** | mixto | «MEDIDO en Chrome, con el teclado...»; cita «el dueño los pidió con esa palabra» |
| `apps/console/src/features/accounts/quotas.ts` | 50 | 26% | **14** | mixto | ««AGOTADO» y «100% libre», en la misma línea.**  la tarjeta de `codex`...» (mutilado); «el equipo YA LO SABÍA» |
| `apps/console/src/nav.ts` | 47 | 52% | **14** | mixto | «Este es el menú final del 2026-08-22, después de tres retiradas...»; «ROUTE_ALIASES`.** Un id...» (** huérfan |
| `apps/console/src/features/live/vocabulario-de-estados.test.ts` | 41 | 41% | **14** | mixto | «**LA MISMA SITUACIÓN...**  Convivían dos vocabularios de estado en» (mutilado, arranca sin sujeto); resto es  |
| `apps/console/src/features/live/LiveFleetPage.sin-salida.test.tsx` | 31 | 28% | **14** | narrativo | «tras tres HTTP 500 en `/v3/auth/session`, `/live` se quedó 180 s...» (mutilado línea 12, sin sujeto) |
| `apps/console/src/features/landing/LandingPage.permisos.test.tsx` | 30 | 30% | **14** | narrativo | «Historia, porque explica por qué estas pruebas dicen ahora lo contrario...» enumera 3 rondas fechadas (commit |
| `packages/adapter-sdk/src/shared-session/tmux.ts` | 265 | 17% | **13** | invariante | prosa de concurrencia/TOCTOU real (CAS, if-shell, wait-for); casi todo es restricción de protocolo, muy poco r |
| `packages/adapter-sdk/src/sdk/engine.ts` | 158 | 12% | **13** | invariante | reglas de estado durable/claim; sustantivo |
| `apps/console/src/features/queues/colas-puras.test.ts` | 52 | 26% | **13** | mixto | «el fallo REAL que cometí dos veces»; resto CONTROL NEGATIVO real |
| `apps/console/src/features/terminal/estilos-en-linea.test.ts` | 37 | 40% | **13** | mixto | «MEDIDO contra producción, abrir la terminal dejaba 22 violaciones»; resto es explicación técnica real de CSP |
| `packages/adapter-sdk/src/shared-session/paste-runner.ts` | 245 | 13% | **12** | invariante | reglas de exclusión/cuarentena del pane; casi todo es invariante de seguridad de concurrencia |
| `apps/console/src/api/client.ts` | 151 | 18% | **12** | invariante | por qué cada endpoint hace lo que hace (CSRF, timeouts); sustantivo |
| `packages/adapter-sdk/src/context/perfil-a-contexto.ts` | 115 | 65% | **12** | invariante | documento de arquitectura del compilador de contexto; denso pero todo es invariante/porqué de diseño |
| `apps/console/src/features/live/LiveHypergraph.tsx` | 82 | 17% | **12** | mixto | mezcla docs de honestidad de datos con «antes esto era ?? 'down', y era un BUG» narrativo puntual |
| `apps/console/src/features/queues/DeliveryTable.tsx` | 49 | 16% | **12** | mixto | «...mostraba «UNKNOWN» en naranja bajo «Último» (mutilado, sin sujeto); «Salido del recorrido del 2026-08-23» |
| `apps/console/src/features/terminal/cuerpo-del-mensaje.ts` | 39 | 67% | **12** | mixto | «...en ninguna parte.  100 items, largo máximo de `body_preview`...» (mutilado); cita textos truncados reales  |
| `apps/console/src/features/accounts/licenses.ts` | 76 | 16% | **11** | mixto | «...tenía su propia página, `LicensesPage`;  página vive fusionada; » (mutilado, frase partida) |
| `apps/console/src/features/live/AgentDrawer.tsx` | 63 | 16% | **11** | mixto | «...estaba escrita por duplicado en los 14 alias.  sitio; esto es ese sitio.» (mutilado, frase cortada) |
| `apps/console/src/features/messages/roster.ts` | 57 | 29% | **11** | mixto | narra el incidente «gaia» (repetido en varios ficheros) como historia; regla real subyacente |
| `apps/console/src/mocks/handlers.ts` | 55 | 14% | **11** | mixto | fechas «2026-08-24», «2026-08-23» de verificación contra producción dentro de comentarios de fixture |
| `apps/console/src/features/config/campos-inertes.test.ts` | 43 | 32% | **11** | mixto | «MEDIDO en Chrome, mirando la pantalla...»; resto CONTROL NEGATIVO real con citas ruta:línea |
| `apps/console/src/features/landing/LandingPage.tsx` | 41 | 23% | **11** | mixto | cita del dueño «adapters se convierte en landing con toda la data...»; «el precio se midió el 2026-08-22» |
| `apps/console/src/features/terminal/plazas.ts` | 38 | 59% | **11** | mixto | «Esto existe por un fallo  Ultimate Terminal «nunca ha funcionado»...» (mutilado, sin sujeto) |
| `apps/console/src/features/live/perfil.ts` | 69 | 24% | **10** | mixto | menciona incidente «el 16-ago un alias se quedó SORDO» con fecha, resto invariante |
| `apps/console/src/features/messages/ConversationPane.tsx` | 65 | 13% | **10** | mixto | bloque narrativo con medición «Chrome a 1280x900... quedaban 42 px» |
| `apps/console/src/features/config/CollectionTable.tsx` | 52 | 16% | **10** | mixto | «269 px de alto... 170 eran el volcado de JSON... medidos en Chrome» |
| `apps/console/src/mocks/browser.ts` | 34 | 57% | **10** | mixto | «Medido en la consola desplegada: al entrar directo a una vista se dibujaba entera, pero...» |
| `apps/console/src/features/live/capas-pendientes.ts` | 33 | 36% | **10** | mixto | «LO QUE » (título truncado, mutilado); cita «Qué preguntó Steven, en sus términos» |
| `apps/console/src/features/messages/MessagesPage.tsx` | 46 | 20% | **9** | mixto | «Medido en producción a 1280x900: el `textarea` estaba en y=1546...» |
| `apps/console/src/features/terminal/densidad-observacion.test.tsx` | 37 | 32% | **9** | mixto | CONTROL NEGATIVO real con aviso de método jsdom, poco narrativo puro |
| `apps/console/src/features/messages/messages-css.test.ts` | 34 | 33% | **9** | mixto | «fallo que cometí escribiendo el arreglo del fan-out»; resto es regla real de clases CSS |
| `apps/console/src/mocks/terminal-demo.ts` | 41 | 24% | **8** | mixto | «Acá decía `'live-tui'`, y el cliente busca `'harness'`... Se descubrió midiendo» |
| `apps/console/src/features/queues/filtro-de-colas.ts` | 38 | 43% | **8** | mixto | «Recorrido de producción del 2026-08-23...»; resto regla real |
| `apps/console/src/features/live/ficheros-legibilidad.test.ts` | 28 | 30% | **8** | mixto | «se midió con Chrome... a 1,36:1 de contraste... y con él sale a 7,44:1» |
| `apps/console/src/features/queues/ultimo-error.ts` | 27 | 57% | **8** | mixto | «**«UNKNOWN» ÁMBAR...**  38 filas en la tabla de `/queues`, de las» (mutilado, sin sujeto) |
| `packages/adapter-sdk/src/sdk/durable-store.ts` | 137 | 7% | **7** | invariante | WAL/recuperación; casi todo invariante |
| `apps/console/src/features/live/historial-rol.ts` | 74 | 37% | **7** | invariante | reglas reales de ordenamiento/semántica del diario de roles |
| `apps/console/src/features/live/role-brief.ts` | 59 | 68% | **7** | invariante | regla de tope real; incluye «GUARDA TEMPORAL — zeus 2026-08-22» que es un TODO operativo, no cuento |
| `apps/console/src/features/queues/foco-de-entrega.ts` | 33 | 52% | **7** | mixto | cita commit `d3411de`; «Lo que la consola NO puede saber...** `GET /v3/console/queues`» (** huérfano leve) |
| `apps/console/src/features/live/activity.ts` | 70 | 24% | **6** | invariante | semántica de null/UNKNOWN real |
| `apps/console/src/features/live/ficheros.ts` | 59 | 34% | **6** | invariante | taxonomía real de motivos de bloqueo, una mención a Steven |
| `apps/console/src/features/messages/queue-health.ts` | 58 | 40% | **6** | invariante | techos reales del servidor citados con archivo:línea |
| `apps/console/src/components/ui.tsx` | 56 | 20% | **6** | invariante | vocabulario real de ausencia de dato |
| `apps/console/src/features/live/FleetActivityTable.tsx` | 50 | 13% | **6** | invariante | por qué titular y señales salen de dos fuentes distintas; real |
| `apps/console/src/features/terminal/session.ts` | 35 | 17% | **6** | mixto | «Vivió, entre el 2026-08-23 y la fusión de ese mismo día»; explica migración de lógica |
| `apps/console/src/features/accounts/AccountRoutingDetail.tsx` | 23 | 24% | **6** | mixto | «El 2026-08-22 se midió... Steven pidió fundirlos...» |
| `packages/adapter-sdk/src/shared-session/session.ts` | 92 | 10% | **5** | invariante | reglas de identidad de sesión tmux; sustantivo |
| `apps/console/src/features/config/config-change.ts` | 36 | 37% | **5** | invariante | por qué 403 en lectura no es caída; real, algo de tono retórico |
| `apps/console/src/features/audit/AuditPanel.tsx` | 33 | 20% | **5** | invariante | explica fusión de vistas con cita de otro comentario; algo de historia de refactor |
| `packages/adapter-sdk/src/sdk/output-parser.ts` | 87 | 7% | **4** | invariante | parsing de dialectos de arnés; sustantivo |
| `packages/adapter-sdk/src/sdk/types.ts` | 84 | 21% | **4** | invariante | docs de campo de protocolo, casi todo de una línea |
| `packages/adapter-sdk/src/sdk/artifact-inliner.ts` | 83 | 34% | **4** | invariante | seguridad de ficheros (O_NOFOLLOW, symlinks); crítico, no tocar |
| `packages/adapter-sdk/src/context/siembra-del-perfil.ts` | 73 | 14% | **4** | invariante | seguridad de escritura de ficheros (openat/O_NOFOLLOW); crítico |
| `apps/console/src/features/accounts/registry.ts` | 52 | 9% | **4** | invariante | semántica real de campos redactados/visible/absent |
| `packages/adapter-sdk/src/harnesses/contexto-fijo.ts` | 51 | 28% | **4** | invariante | reglas de sello/fusión de ficheros; sustantivo |
| `apps/console/src/components/Tooltip.tsx` | 44 | 34% | **4** | invariante | por qué createPortal, por qué foco; real |
| `apps/console/src/features/config/use-interruptores.ts` | 43 | 23% | **4** | invariante | regla real de reversión optimista |
| `apps/console/src/features/config/SpaceWizard.tsx` | 37 | 13% | **4** | invariante | por qué se retiró un campo; real |
| `apps/console/src/main.tsx` | 16 | 39% | **4** | mixto | «Medido: detrás de una auth básica, el registro del service worker puede recibir 401...» |
| `packages/adapter-sdk/src/shared-session/types.ts` | 60 | 41% | **3** | invariante | enum docs de una línea, semántica real |
| `apps/console/src/features/terminal/relay-status.ts` | 38 | 24% | **3** | invariante | doctrina real de ausente vs no-desplegado |
| `apps/console/src/features/auth/AuthGate.tsx` | 36 | 17% | **3** | invariante | doctrina de sesión real, sin narrativa |
| `apps/console/src/features/queues/QueuesPage.tsx` | 33 | 15% | **3** | invariante | real, por qué useSyncExternalStore/popstate |
| `apps/console/src/features/config/campos-inertes.ts` | 32 | 37% | **3** | invariante | catálogo real con citas ruta:línea verificadas |
| `apps/console/src/features/config/arneses.test.ts` | 25 | 35% | **3** | invariante | tabla real verificada contra el gateway |
| `apps/console/src/features/live/FleetVerdict.tsx` | 21 | 23% | **3** | invariante | real, con leve tono retórico |
| `packages/adapter-sdk/src/sdk/websocket-transport.ts` | 43 | 11% | **2** | invariante | seguridad de logging (nunca loguear el body); crítico |
| `packages/adapter-sdk/src/shared-session/rollout.ts` | 42 | 16% | **2** | invariante | parsing de rollouts de Codex; sustantivo |
| `packages/adapter-sdk/src/shared-session/transcript.ts` | 40 | 12% | **2** | invariante | parsing JSONL de Claude; sustantivo |
| `apps/console/src/App.tsx` | 31 | 12% | **2** | invariante | real, code-splitting y rutas |
| `apps/console/src/navigation.ts` | 28 | 37% | **2** | invariante | real, sin narrativa |
| `apps/console/src/features/config/AltaRapida.tsx` | 28 | 16% | **2** | invariante | real, sin narrativa |
| `apps/console/src/features/live/AgentTooltipCard.tsx` | 27 | 22% | **2** | invariante | real, doctrina de qué no se muestra en el tooltip |
| `apps/console/src/features/config/roles.ts` | 27 | 28% | **2** | invariante | real |
| `apps/console/src/api/use-resource.ts` | 26 | 18% | **2** | invariante | real, sin narrativa |
| `apps/console/src/features/config/alta-rapida.ts` | 24 | 19% | **2** | invariante | real |
| `apps/console/src/features/config/fecha-relativa.ts` | 24 | 41% | **2** | invariante | real, decisión de formato justificada |
| `apps/console/src/features/live/ChainPanel.tsx` | 23 | 19% | **2** | invariante | real |
| `apps/console/src/features/config/arneses.ts` | 22 | 23% | **2** | invariante | real |
| `apps/console/src/features/live/DirectivaTab.tsx` | 20 | 16% | **2** | invariante | real |
| `packages/adapter-sdk/src/shared-session/envelope.ts` | 24 | 29% | **1** | invariante | real, seguridad de correlación |
| `packages/adapter-sdk/src/shared-session/pane.ts` | 23 | 18% | **1** | invariante | real |
| `apps/console/src/features/messages/desplazamiento.ts` | 20 | 49% | **1** | invariante | real |
| `packages/adapter-sdk/src/sdk/account-credentials.ts` | 19 | 23% | **1** | invariante | real |
| `packages/adapter-sdk/src/shared-session/config.ts` | 19 | 17% | **1** | invariante | real |
| `apps/console/src/features/auth/auth-session.ts` | 18 | 19% | **1** | invariante | real |
| `apps/console/src/features/terminal/pty-socket-stub.ts` | 17 | 16% | **1** | invariante | real |
| `apps/console/src/features/config/collections.ts` | 17 | 30% | **1** | invariante | real |
| `apps/console/src/test/setup.ts` | 14 | 22% | **1** | invariante | real, por qué el polyfill existe |
| `apps/console/src/features/config/ArnesesPanel.tsx` | 14 | 24% | **1** | invariante | real, fecha «23-ago-2026» breve dentro de justificación |
| `apps/console/src/features/landing/HarnessStrip.tsx` | 13 | 16% | **1** | invariante | real |
| `packages/adapter-sdk/src/shared-session/degradation-log.ts` | 13 | 18% | **1** | invariante | real |
| `apps/console/src/features/accounts/MutationBar.tsx` | 11 | 25% | **1** | invariante | real |
| `apps/console/src/features/terminal/doctrina.ts` | 9 | 82% | **0** | invariante | real, por qué existe en módulo propio |
| `apps/console/src/features/topology/AclEdgeList.tsx` | 7 | 24% | **0** | invariante | real |
| `apps/console/src/features/accounts/Sparkline.tsx` | 7 | 21% | **0** | invariante | real |
| `packages/adapter-sdk/src/index.ts` | 5 | 17% | **0** | invariante | real, por qué se reexporta |

## Comentarios — ops/**/*.py, ops/**/*.sh, ops/**/*.mjs, deploy/*.mjs, deploy/*.sh, scripts/*

ZONA ops/**+deploy/*+scripts/* (162 ficheros fuente .py/.sh/.mjs, sin contar tests salvo >25%): 3.152 líneas de comentario sobre 37.163 líneas totales = 8,5% de densidad media. Candidatos que cumplen el umbral (>30 líneas o >15% densidad, tests excluidos salvo >25%): 39 ficheros, 39 filas en la tabla, con 1.986 líneas de comentario entre todos (63% del total de la zona). Borrables estimadas sobre esos 39: ~79 líneas (~4% de sus propios comentarios; ~2,5% del total de la zona) — la inmensa mayoría de lo que hay es [invariante] genuino: contratos de wire-protocol, condiciones de carrera, límites medidos de Postgres/systemd/tmux, reglas de seguridad — texto que el código no puede decir por sí solo. NO se encontró ningún fichero con [mutilado] como clase dominante en el HEAD actual: revisé el commit 2a22107 (la "limpieza masiva" citada, 131 commits atrás) y en esta zona reescribió limpio lo que tocó (p.ej. cauce-kratos.sh, cauce-cuentas.py, cred-guard.py, medir-terminal.mjs, servir-con-csp.mjs, paquetes-de-este-arbol.mjs: todos ya limpios hoy). Tampoco hay [sql-string]: hay varios `query = '''SELECT...'''` (fleet-watchdog.py) y llamadas psql (quota-collector.py) pero ninguna trae comentarios SQL "--" dentro del string — son datos, no ruido. AVISO METODOLÓGICO IMPORTANTE: una medición ingenua por regex (línea empieza con # o dentro de """) sobrecuenta brutalmente en Python cuando hay un query SQL en triple comillas asignado a variable (`query = '''...'''`): confunde el CIERRE de ese string con la APERTURA de un docstring nuevo y cuenta código SQL entero como "comentario". Con esa medición ingenua, fleet-watchdog.py salía en 466 líneas/79,7% (lo hubiera puesto primero en la tabla); con AST+tokenize correctos son 44/7,5%. Mismo defecto infló generate-container-units.py (98→4), generate-units.py (38→1), verify-hermes-runtime.py (126→2), test_runtime_facts.py (198→7) y test_config_por_alias_supervisor.py (170→44, y por eso cae del corte >25% al ser test). Usé el método corregido para toda la tabla. Los 3 peores ficheros (por línea de ruido real, no por volumen bruto): 1) ops/tests/test_container_runtime_zombies.py — de sus 65 líneas de comentario, ~45 son [ceremonial] puro: narran paso a paso lo que la línea de código de abajo ya dice ("# Now reap them using the guard's reap_children function" justo antes de llamar a reap_children()). 2) ops/scripts/source-digest.py — su docstring de módulo (134 líneas, 34% de densidad) mezcla reglas de dominio realmente invariantes con un origen narrado como cuento ("Eso ya pasó. El gate no detectaba forgery, estaba manufacturando el incentivo para ello"), ~10 líneas borrables. 3) ops/pty-agent/cauce_pty_agent.py — el fichero más grande de la zona (300 líneas de comentario, 2.668 totales); calidad altísima en general, pero trae dos citas de incidente con fecha exacta incrustadas en medio de razonamiento técnico legítimo ("medido el 2026-07-31", "el 23-ago-2026 el registro se equivocaba de arnés en 5 de los 14 alias") que son BORRABLES aunque el párrafo que las rodea deba quedarse. Conclusión honesta para el dueño: esta zona (ops/deploy/scripts) NO es donde vive el "demasiado ruido" — ya está disciplinada. Si el ruido persiste, probablemente está concentrado en otras zonas del censo (apps/, services/, packages/) o es percepción por LONGITUD (párrafos invariantes muy largos que la propia regla pide "reescribir en una línea", no borrar) más que por contenido narrativo real.

| Fichero | Coment. | % | Borrables | Clase | Ejemplo |
|---|---|---|---|---|---|
| `ops/tests/test_container_runtime_zombies.py` | 65 | 28% | **45** | ceremonial | '# Now reap them using the guard's reap_children function' justo antes de la linea reap_children(...) — narra  |
| `ops/scripts/source-digest.py` | 134 | 34% | **10** | mixto | 'Eso ya paso. El gate no detectaba forgery, estaba manufacturando el incentivo para ello' — historia dentro de |
| `ops/pty-agent/cauce_pty_agent.py` | 300 | 11% | **5** | invariante | casi todo protocolo/seguridad legítimo; 2 citas de fecha-incidente incrustadas: 'el 23-ago-2026 el registro se |
| `ops/scripts/quota-collector.py` | 162 | 23% | **4** | invariante | docstring cita origen narrado: 'el incidente que motivo este trabajo (un agente con 71 entregas en vuelo...)' |
| `ops/guardias/cauce-kratos.sh` | 108 | 19% | **3** | invariante | 'Medido el 2026-07-31: solo argos coincidia, por azar' es la unica fecha suelta en el fichero |
| `ops/pty-agent/tests/__init__.py` | 15 | 94% | **3** | mixto | 'con 74 pruebas escritas al lado sin ejecutarse' es la cifra narrada; el resto explica un invariante real de u |
| `ops/scripts/install-cauce-cli.sh` | 13 | 34% | **3** | mixto | 'El CLI del dueño vivió catorce meses sólo en su home, sin git' es historia de origen; el resto (por que 3 pie |
| `ops/scripts/generate-telegram-config.py` | 154 | 18% | **2** | invariante | 'Historically only a test fixture ... wrote a Telegram bridge config' es lo unico narrativo en 154 lineas |
| `ops/scripts/host-backup.sh` | 62 | 18% | **1** | invariante | '(verified 2026-07-25: passing the real path doubled it)' es la unica fecha suelta |
| `ops/scripts/ut-nexus-backup.py` | 44 | 18% | **1** | invariante | 'verificado 2026-07-25: 27 de 30 filas de workers diferian' es la unica fecha suelta |
| `ops/console-legibilidad/medir-terminal.mjs` | 37 | 16% | **1** | invariante | ya reescrito por 2a22107; queda un resto de 'Antes del arreglo el defecto no era este' que podria caer |
| `ops/guardias/polidin-guard.sh` | 9 | 41% | **1** | invariante | 'que es lo que paso el 02-ago' es la unica fecha suelta |
| `ops/container-runtime/cauce-container-runtime.py` | 138 | 8% | **0** | invariante | razonamiento de carreras pidfd/PID reuse, sin fechas ni historia; ejemplo de invariante bien escrito |
| `ops/pty-agent/cauce-pty-launcher.sh` | 112 | 14% | **0** | invariante | exit codes reservados, TOCTOU de tickets, bloqueo de flock — sin narrativa |
| `ops/scripts/container-adapter-supervisor.sh` | 94 | 10% | **0** | invariante | reglas de aislamiento por alias con razon tecnica exacta (mismo INODO de config), sin cuento |
| `ops/scripts/separar-config-alias.mjs` | 75 | 28% | **0** | invariante | 'LA TRAMPA, QUE YA SE PAGO UNA VEZ' es dramatico en el titulo pero el cuerpo es la regla real, sin fecha ni no |
| `ops/console-legibilidad/medir-tipografia.mjs` | 49 | 22% | **0** | invariante | cifras MEDIDAS (368 vs 344 px) usadas para justificar por que se filtran pseudo-elementos, no narradas como an |
| `ops/scripts/fleet-watchdog.py` | 44 | 8% | **0** | invariante | OJO: medicion ingenua por regex daba 466L/79.7% por confundir el cierre de un query SQL en ''' con un docstrin |
| `ops/console-legibilidad/medir.mjs` | 42 | 26% | **0** | invariante | 'costó dos horas de intermitencia' justifica por qué se toman 3 muestras — funcional, no anécdota gratuita |
| `ops/openclaw-gateway/openclaw-gateway-supervisor.sh` | 39 | 16% | **0** | invariante | 'LAS DOS TRAMPAS QUE RESUELVE' son fallos reales de docker exec + señales, sin fecha ni nombre |
| `ops/guardias/hegel-ventas-checkin.py` | 39 | 42% | **0** | invariante | docstring puramente operacional (autenticacion mTLS, idempotencia, sin secretos), cero narrativa |
| `ops/scripts/update-alias-config.py` | 37 | 3% | **0** | invariante | CAS/fsync/rename y modelo de reversa causal explicados sin historia |
| `ops/guardias/cauce-envoltorio-local.sh` | 36 | 30% | **0** | invariante | ya reescrito por 2a22107 (le quitaron 'Lo escribio la sesion de relevo del 2026-07-31'); hoy limpio |
| `ops/scripts/telegram-cutover-preflight.py` | 35 | 12% | **0** | invariante | lista de condiciones fail-closed con referencia exacta a config.ts, sin narrativa |
| `ops/pty-agent/rollout-pty.py` | 34 | 3% | **0** | invariante | UID de systemd --user, compensacion inversa de transacciones — todo tecnico |
| `ops/pty-agent/tests/test_presencia_home.py` | 33 | 31% | **0** | invariante | cada test explica el porque del invariante que prueba, no narra pasos obvios |
| `deploy/liveness-probe.mjs` | 32 | 18% | **0** | invariante | tabla de veredictos sonda de progreso vs sonda de respuesta, sin fecha ni cuento |
| `ops/patches/openclaw-turn-compaction-guard.mjs` | 29 | 36% | **0** | invariante | explica por que el catch va despues del bloque exacto, con la razon sintactica, no historia |
| `ops/guardias/cauce-cuentas.py` | 29 | 15% | **0** | invariante | ya reescrito por 2a22107 (perdio la fecha 2026-08-04 y el 'el 2026-07-31'); hoy limpio |
| `ops/guardias/cred-guard.py` | 23 | 22% | **0** | invariante | ya reescrito por 2a22107 (perdio 'El 2026-08-03 janus y claw-iza llevaban dias...'); hoy limpio |
| `ops/console-legibilidad/servir-con-csp.mjs` | 21 | 24% | **0** | invariante | ya reescrito por 2a22107 (perdio 'El 2026-08-23 la TUI se desplego ilegible'); hoy limpio |
| `ops/pty-agent/derive-alias-key.py` | 17 | 17% | **0** | invariante | separacion de dominio de claves HKDF, probar hex antes que base64 — sin narrativa |
| `ops/pty-agent/tests/test_suite_completeness.py` | 16 | 27% | **0** | invariante | control negativo explicado por que hace falta, no narrado como anecdota |
| `ops/guardias/contenedor/polidin-fwd.sh` | 16 | 64% | **0** | invariante | cadena de red y por que cada salto no se puede evitar (sudo -n falla, AllowTcpForwarding=no) |
| `ops/patches/apply-openclaw-turn-compaction-guard.sh` | 11 | 26% | **0** | invariante | por que un fallo no detiene al resto de la flota — funcional |
| `deploy/smoke.sh` | 9 | 21% | **0** | invariante | encabezados numerados de cada chequeo post-deploy, cortos y funcionales |
| `scripts/gancho-de-paquetes.mjs` | 9 | 30% | **0** | invariante | explica el alcance exacto del gancho de resolucion (solo @cauce/*), sin narrativa |
| `scripts/paquetes-de-este-arbol.mjs` | 4 | 36% | **0** | invariante | ya reescrito por 2a22107 (perdio el relato del worktree wt-integra); hoy es 1 parrafo tecnico |
| `ops/guardias/cred-guard.sh` | 3 | 30% | **0** | invariante | por que va en script y no en ExecStart= (systemd no expande $(date)) — invariante minimo |

## Basura — ZONA BASURA 1 — raíz y ocultos

| Ítem | Tipo | Tamaño | Veredicto | Evidencia |
|---|---|---|---|---|
| `.mypy_cache/` | cache | 4.4M (existía al inicio del censo; desap | borrar | du -sh dio 4.4M en el primer barrido; en un stat posterior ya no existía ('No such file or directory') sin que yo lo toc |
| `.pytest_cache/` | cache | 40K (desapareció igual que .mypy_cache d | borrar | Mismo patrón: presente al inicio (du -sh 40K, mtime 12-ago, el más viejo de los tres), ausente minutos después sin acció |
| `.ruff_cache/` | cache | 32K (desapareció igual que los anteriore | borrar | Mismo patrón de autolimpieza que .mypy_cache/.pytest_cache. Generado por ruff sobre el código Python de ops/. Gitignored |
| `.serena/` | cache | 668K | conservar | Herramienta activa: referenciada en docs/bitacora/handoff-codex-directiva-20260825.md y ordenes/reportes/minimax-gitigno |
| `.test-state/ (raíz)` | cache | 7.4M, 126 subdirectorios | dudoso | El propio comentario en .gitignore lo describe: '# test state / evidence (regenerable)'. mtime 2026-08-27 04:14, dueño s |
| `packages/adapter-sdk/.test-state/` | cache | 2.9M, 112 subdirectorios | dudoso | Directorio DISTINTO del .test-state/ raíz (solo 104 de 126 nombres se solapan; comparé con `diff` de listados ordenados) |
| `.claude/` | otro | 16K | conservar | scheduled_tasks.lock contiene sessionId 'b878cae0-58ad-4046-96fa-2f4ef7455d07', que coincide exactamente con el ID de ES |
| `.github/workflows/` | otro | 12K | conservar | Solo contiene ci.yml (1 job typecheck-lint + resto del pipeline). find .github -type f no devolvió nada más: sin CODEOWN |
| `node_modules/ (raíz)` | otro | 268M | conservar | Estructura pnpm estándar (store .pnpm/ + symlinks), necesaria para build/test/lint del monorepo. Gitignored y en .docker |
| `apps/console/node_modules/, packages/{adapter-sdk,mcp-fleet-monitor,protocol,store}/node_modules/, services/{dispatcher,gateway,telegram-bridge,terminal-relay}/node_modules/` | otro | apps/console: 196K; los 8 restantes: 292 | conservar | Verificado con `ls -la`: son symlinks al store central node_modules/.pnpm/ más .bin/ y cachés .vite/ — layout normal de  |
| `dist/ (raíz)` | build | 4.2M | conservar | Es el outDir real de tsconfig.build.json ('outDir: dist'), producido por el script 'build' de package.json (build:core → |
| `packages/adapter-sdk/dist/, packages/mcp-fleet-monitor/dist/, packages/protocol/dist/, apps/console/dist/` | build | 3.8M, 3.1M, 276K, 4.5M respectivamente | conservar | Salidas de build por-paquete (tsc/vite) referenciadas por los scripts build:adapter/build:mcp/build:console de package.j |
| `*.tsbuildinfo` | otro | 10 ficheros encontrados, todos dentro de | conservar | find . -name '*.tsbuildinfo' (excluyendo node_modules) devolvió CERO resultados propios del repo — ningún build del prop |
| `coverage/` | otro | 0 (no existe) | conservar | find . -type d -name coverage (excluyendo node_modules) no devolvió nada, ni en raíz ni en ningún subnivel. Nada que cen |
| `ops/artifacts/{real,release,restarts}/` | otro | 48K (junit.xml, report.json, SHA256SUMS, | conservar | Evidencia operativa real de corridas recientes (mtimes 25-26 ago: build.json de release, junit.xml/report.json de test r |
| `ops/private/CREDENTIAL-INVENTORY.local` | otro | 12K (fichero de 7216 bytes, permisos 600 | conservar | Fichero sensible legítimo (inventario de credenciales), correctamente excluido por el patrón '*.local' del .gitignore y  |
| `ops/guardias/__pycache__/, ops/scripts/__pycache__/, ops/pty-agent/tests/__pycache__/` | cache | 12K + 1.1M + 620K = ~1.73M total | borrar | Bytecode compilado de Python (.pyc) para hasta TRES intérpretes distintos conviviendo (cpython-311, cpython-312, cpython |
| `ficheros sueltos no trackeados en raíz (fuera de directorios)` | otro | 0 | conservar | git status --ignored --porcelain no reporta ningún fichero suelto (todas las líneas '!!' corresponden a directorios ya c |

## Basura — ZONA BASURA 2 — builds y artefactos por paquete

| Ítem | Tipo | Tamaño | Veredicto | Evidencia |
|---|---|---|---|---|
| `packages/protocol/dist` | build | 276K | borrar | gitignorado por regla global `**/dist/` en .gitignore; `git ls-files packages | grep /dist/` = 0 resultados; se regenera |
| `packages/mcp-fleet-monitor/dist` | build | 3.1M | borrar | mismo patrón: gitignorado, 0 ficheros trackeados, regenerable por build del paquete. |
| `packages/adapter-sdk/dist` | build | 3.8M | borrar | gitignorado, 0 trackeados. Generado por `pnpm --filter @cauce/adapter-sdk build` (tsc + scripts/copy-bridges.mjs + scrip |
| `packages/*/dist-test` | otro | 0 (no existe) | conservar | `find . -iname 'dist-test*'` sin resultados en todo el árbol (excluyendo node_modules). No hay tal directorio hoy; proba |
| `packages/adapter-sdk/bridge` | otro | 20K (2 ficheros: hermes-stdin-bridge.py, | conservar | NO es artefacto de build, es FUENTE trackeada (`git ls-files` los lista). `package.json` de adapter-sdk: `build` los cop |
| `packages/adapter-sdk/manifests` | otro | 28K (6 JSON: claude/codex/fake/hermes/op | conservar | Fuente trackeada. Listado en `package.json` -> `files` (se publica con el paquete). Cubierto por packages/adapter-sdk/te |
| `packages/adapter-sdk/scripts` | otro | 16K (chmod-bins.mjs, copy-bridges.mjs, p | conservar | Fuente trackeada, invocada directamente por los scripts `build` y `smoke:package` de packages/adapter-sdk/package.json.  |
| `packages/adapter-sdk/node_modules` | otro | 52K hoy (solo symlinks pnpm: typescript, | conservar | El node_modules de 264MB mencionado vivía en un WORKTREE, no en este checkout. `git worktree list` hoy solo devuelve `/d |
| `apps/console/dist` | build | 4.5M | borrar | gitignorado (`**/dist/`), `git ls-files apps/console | grep /dist/` = 0. Contiene apps/console/dist/assets, salida de vi |
| `apps/console/public` | otro | 16K | conservar | Contiene mockServiceWorker.js, SÍ trackeado en git (único fichero del directorio). Usado por apps/console/src/mocks/brow |
| `ops/generated/container-systemd/rootless` | build | 140K (16 .service + 16 configs/*.env.exa | conservar | Generado por `pnpm ops:manifests` -> `generate-container-units.py --rootless --output ops/generated/container-systemd/ro |
| `ops/generated/systemd` | build | 68K (15 cauce-v3-alias-*.service + SHA25 | conservar | Generado por `generate-units.py` (modo alias, sin --rootless). Trackeado íntegro en git. Mismo drift-check en ops/script |
| `ops/artifacts` | cache | 48K (real/, restarts/, release/ — junit. | conservar | Ya gitignorado (`ops/artifacts/` en .gitignore) y `git ls-files ops/artifacts` = 0 — no ensucia el repo. Generado por `p |
| `dist/ (raíz del repo)` | build | 4.2M | borrar | No pedido explícitamente en el censo pero mismo patrón: gitignorado, 0 trackeados, salida de `tsc` sobre tsconfig.build. |
| `deploy/fleet-snapshot.mjs` | huerfano | 2.6K | dudoso | SÍ se copia a la imagen de producción (deploy/Dockerfile:93, COPY masivo). Pero: (1) su propio comentario dice que lo ej |
| `deploy/liveness-probe.mjs` | huerfano | 7.3K | dudoso | HALLAZGO PRINCIPAL de esta zona: tiene documentación extensa en cabecera y DOS suites de test completas (services/dispat |
| `deploy/migration-integrity.mjs` | huerfano | 2.2K | dudoso | Se copia a la imagen (Dockerfile:93). Su lógica interna (inspectMigrationIntegrity) SÍ se ejecuta en cada arranque real  |
| `deploy/schema-version.mjs` | huerfano | 0.8K | dudoso | Se copia a la imagen (Dockerfile:93). Ningún script/runbook/test lo invoca (grep fuera de sí mismo y del Dockerfile: 0 c |
| `deploy/outbox-metrics-core.d.mts` | otro | 298B (solo tipos, 1 interfaz + 1 función | conservar | grep directo del nombre de fichero = 0 coincidencias en todo el repo, pero SÍ está en uso: tests/unit/outbox-metrics.tes |
| `deploy/outbox-metrics.mjs` | otro | 3.5K | dudoso | Copiado a la imagen, referenciado por runtime-package-smoke.mjs y usado como servicio `outbox-metrics` en deploy/compose |
| `deploy/runtime-package-smoke.mjs` | otro | 9.1K | conservar | Vivo y central: ejecutado en build de imagen (`RUN node deploy/runtime-package-smoke.mjs`, Dockerfile:97) y por deploy/s |
| `deploy/reconcile-stale-console-outbox.mjs` | huerfano | 1.8K | dudoso | Copiado a la imagen (Dockerfile:93), con guardas serias (fase `apply` exige `CAUCE_OUTBOX_RECONCILE_CONFIRM` exacto) — d |
| `deploy/reconcile-stale-console-outbox-core.mjs` | otro | 8.1K | conservar | A diferencia del wrapper, la lógica 'core' SÍ tiene consumidor de test real: packages/store/test/legacy-console-outbox-r |
| `deploy/reconcile-stale-console-outbox-core.d.mts` | otro | 890B | conservar | Mismo patrón que outbox-metrics-core.d.mts: sin import explícito por nombre de fichero, pero resuelto implícitamente por |

## Basura — Zona 3 — documentación y metadatos (docs/, docs/bitacora, ordenes/reportes/, plan-reestructura/, tests/fleet-release/artifacts, .gitattributes, .dockerignore, pnpm-workspace.yaml)

| Ítem | Tipo | Tamaño | Veredicto | Evidencia |
|---|---|---|---|---|
| `docs/directiva-ficheros-del-agente.md` | otro | 9.9K | conservar | medido dentro de contenedores 23-ago (via /proc/pid), citado en 5 reportes de ronda (minimax-enlaces, minimax-enlaces-r5 |
| `docs/terminal-pty.md` | otro | 18.8K | conservar | runbook operativo del canal PTY (piernas del relay, mTLS, tags binarios), citado en 4 reportes de ronda, último commit 2 |
| `docs/bitacora/ (528K, 51 ficheros trackeados)` | otro | 528K | conservar | 32 ficheros FUERA de bitacora citan rutas dentro de docs/bitacora/ como archivo activo (README.md, CLAUDE.md, AGENTS.md, |
| `ordenes/reportes/claude-matriz-tests.md` | otro | 1.7K | conservar | ACTIVO: citado como insumo pendiente por ordenes/codex.md ('Ver ordenes/reportes/claude-matriz-tests.md §1') y por orden |
| `ordenes/reportes/claude-revision-ola2.md` | otro | 97K | conservar | ACTIVO: la sección 'Cierre' de ordenes/codex.md (orden vigente) lista 5 tareas concretas aún abiertas que remiten a este |
| `ordenes/reportes/claude-revision-46-commits.md` | otro | 57K | dudoso | única cita activa es puntual: docs/arquitectura.md línea 34 lo cita solo para verificar 'SQL intacto en la mudanza (§sto |
| `ordenes/reportes/minimax-foto-final.md` | otro | 10.9K | conservar | ACTIVO: docs/arquitectura.md lo cita como fuente de 'trabajo pendiente de su sector' para los ficheros >800 líneas que q |
| `ordenes/reportes/gemini-vistas-sin-uso.md` | otro | 4.5K | dudoso | decisión del dueño pendiente desde ronda2 (26-08), repetida como tarea CONDICIONAL sin resolver en ronda4 (docs/bitacora |
| `ordenes/reportes/minimax-residuos-host.md` | otro | 11.0K | dudoso | inventario de residuos DEL HOST (fuera del repo, no verificable desde este censo por ser solo-lectura) por ~2,3GB recupe |
| `ordenes/reportes/gemini-ronda-6.md` | otro | 0.6K | conservar | histórico resuelto: reporte de CIERRE de la ronda 6 (partición terminal-relay/telegram-bridge), distinto del fichero de  |
| `ordenes/reportes/minimax-adr.md` | otro | 4.1K | conservar | histórico resuelto: verificación de ADR de ronda 2 (26-08), sin citas activas en ninguna orden ni doc vigente. Recomenda |
| `ordenes/reportes/minimax-runbooks.md` | otro | 6.2K | conservar | histórico resuelto: verificación de runbooks vivos de ronda 2, sin citas activas. Recomendado git mv a docs/bitacora/. |
| `ordenes/reportes/minimax-docs-sueltos.md` | otro | 5.0K | conservar | histórico resuelto: veredicto de ronda 3 sobre los docs sueltos ya APLICADO (docs/directiva-ficheros-del-agente.md y doc |
| `ordenes/reportes/minimax-enlaces.md` | otro | 10.6K | conservar | histórico resuelto: barrido de enlaces de ronda 3, superado por su propia secuela minimax-enlaces-r5.md (ronda 5). Sin c |
| `ordenes/reportes/minimax-enlaces-r5.md` | otro | 6.9K | conservar | histórico resuelto: barrido de enlaces post-mudanzas de ronda 4 (ronda 5, 26-08). La Tarea 5 VIGENTE de ordenes/opencode |
| `ordenes/reportes/minimax-gitignore.md` | otro | 5.1K | conservar | histórico resuelto: auditoría de .gitignore de ronda 5, sin citas activas. Recomendado git mv a docs/bitacora/. |
| `ordenes/reportes/minimax-todos.md` | otro | 3.3K | conservar | histórico/caduco por naturaleza: censo puntual de TODO/FIXME de ronda 5 ('0 marcadores reales' en esa fecha) — un grep c |
| `plan-reestructura/21-correcciones-mapeadas.md` | otro | 3.8K | conservar | mezcla de ítems cerrados y abiertos, verificado línea a línea: ítem 1 (AbortSignal) CONFIRMADO arreglado en apps/console |
| `plan-reestructura/00-LEEME.md` | otro | 5.8K | dudoso | CONTRADICCIÓN vigente confirmada: su sección 'URGENTE' punto 2 dice 'Crear rama limpieza/comentarios-20260827, commitear |
| `plan-reestructura/{31-despliegue-simple,32-flota-pty-y-guardias,33-gobierno-de-flota}.md + fase3/*.md` | otro | 44K | conservar | plan de FASE 3 vigente y citado activamente (README.md, 00-LEEME.md, arquitectura.md); contenido corroborado contra el á |
| `plan-reestructura/censo-contingentes.md` | otro | 8.2K | conservar | tabla de '45 dudosos' pendientes de decisión del dueño, explícitamente preservada por ordenes/opencode-minimax.md (orden |
| `tests/fleet-release/artifacts/{SHA256SUMS,binaries.sha256,junit.xml,report.json}` | build | 28K | gitignore-y-borrar | CONFIRMADO: tests/fleet-release/fleet-release.test.ts línea 450 hace mkdir de este directorio y línea 509 lo BORRA con r |
| `.gitattributes` | config-muerta | 110B | dudoso | única regla '*.patch -whitespace'; find . -iname '*.patch' en todo el repo devuelve CERO resultados hoy. El .patch que l |
| `.dockerignore (bloque `apps/console/src/features/_grafo/` + su comentario)` | config-muerta | ~200B | borrar | CONFIRMADO muerta: el directorio apps/console/src/features/_grafo/ NO EXISTE — fue eliminado en el commit 179d7bf ('refa |
| `.dockerignore (resto: node_modules, dist, coverage, .test-state, ops/artifacts, ops/backups, .git, .serena, *.log, .env*)` | otro | ~110B | conservar | todas con dueño vivo verificado: node_modules/dist/.test-state/.git/.serena existen hoy; coverage lo genera vitest.confi |
| `pnpm-workspace.yaml` | otro | 455B | conservar | los 3 globs casan con directorios reales y no vacíos: packages/{adapter-sdk,mcp-fleet-monitor,protocol,store} (4), servi |

