# Orden de limpieza — validaciones inconexas de Cauce V3

- **Fecha de la auditoría:** 2026-08-29
- **Fecha de la validación:** 2026-08-29, sobre `e95ce5e` (rama `dev`)
- **Qué es este documento:** ya no es un informe. Cada punto es una **orden ejecutable** con su
  destino (BORRAR / TERMINAR / NO TOCAR), el sitio exacto, cómo se comprueba y qué se rompe.
- **Método de validación:** cada afirmación de la auditoría se falsó a mano con `rg` sobre el árbol
  vivo, contando consumidores de producción por separado de los de test. No se ejecutó ningún test
  ni se modificó código al validar.

## Resultado de la validación

De los 7 hallazgos ALTA, **4 se sostienen tal cual, 1 es falso y 2 estaban mal encuadrados**. De los
15 MEDIA, **6 se sostienen** y **9 no son hallazgos**: son defensa en frontera de confianza o
composición interna de esquemas, y tocarlos empeora el código.

| Orden | Qué | Ficheros | Líneas netas | Riesgo |
|---|---|---:|---:|---|
| **A · BORRAR** | 5 piezas muertas de verdad | 7 | **−48** | ninguno |
| **B · TERMINAR** | 5 contratos a medio cablear | 9 | ≈ −30 y drift cerrado | bajo, con gate |
| **C · NO TOCAR** | 9 falsos positivos | — | 0 | borrarlos ABRE agujeros |

---

# ORDEN A · BORRAR — muerto confirmado, retorno inmediato

Los cinco tienen cero consumidores de producción. Borrarlos no cambia ningún comportamiento
observable. **Van en un solo commit**, con el gate completo en verde.

### A1 · La rama `FRAME_SCHEMA` es inalcanzable

- **Borrar:** `packages/adapter-sdk/src/sdk/client.ts:644` — la línea entera y su comentario.
- **Prueba:** `rg "outside the Cauce V3 schema"` da **un solo hit en todo el árbol**: ese mismo
  consumidor. No hay productor. Los frames inválidos de verdad se registran con
  `error_code: 'INBOUND_FRAME_SCHEMA'` / `'OUTBOUND_FRAME_SCHEMA'`
  (`websocket-transport.ts:141,175`), que es un campo del log, no el `error.message` que esta rama
  inspecciona.
- **Se rompe:** nada. Ningún test la cubre.
- **Coste:** 1 línea.

### A2 · `PREFLIGHT_ACK_ERROR_CODES` no ata a nadie

- **Borrar:** `packages/protocol/src/schemas/core.ts:41-55` — la constante y su
  `assertPreflightCodesAreNotAmbiguous()`.
- **Prueba:** cero consumidores en `packages/store/src`, `services/gateway/src` y
  `services/dispatcher/src` (el único hit de «preflight» en el gateway es una palabra suelta en un
  comentario de `agent-documents.routes.ts:514`, otro concepto). La política real de retry vive en
  `packages/store/src/repository/deliveries/acks.ts` y decide con
  `ack.retryable || isAmbiguousAckErrorCode(...)`. Los cinco productores del SDK escriben los
  literales a mano (`harnesses/shared/adapter.ts:396,421`, `sdk/engine/recovery.ts:13`,
  `sdk/engine.ts:444,687`) en vez de importar la constante.
- **Se rompe:** `packages/store/test/retry-policy-postgres.test.ts:4,353`. **Borrar también ese
  caso**: prueba que una lista sin lectores es coherente consigo misma, no un comportamiento.
- **Coste:** 19 líneas.

### A3 · `NON_HUMAN_DELIVERY_MESSAGE_TYPES` nombra una política que se decide por otro eje

- **Borrar:** `packages/protocol/src/schemas/messages.ts:159-162`.
- **Prueba:** cero consumidores de producción. La cuota humana se decide por **prioridad**, no por
  tipo: `m.priority >= HUMAN_PRIORITY_FLOOR` en
  `packages/store/src/repository/deliveries/claims.ts`. La lista puede desincronizarse sin efecto
  visible, que es la definición de constante decorativa.
- **Se rompe:** `tests/unit/gate-probe-authority.test.ts:4,32`. Quitar de ahí el import y el
  `expect(...).toContain('system.gate.probe')`; el resto del fichero prueba otra cosa y se queda.
- **Coste:** 9 líneas.

### A4 · `isHumanPriority` no tiene caller de producción

- **Borrar:** `packages/protocol/src/priority.ts:28` y la función completa.
- **Prueba:** sus únicas referencias son `packages/protocol/test/priority.test.ts` y
  `services/telegram-bridge/test/ingress.test.ts`. La política equivalente está en SQL.
- **Se rompe:** los dos tests. En `ingress.test.ts:55,69` la aserción se reescribe contra
  `HUMAN_PRIORITY_FLOOR` directamente, que es lo que de verdad gobierna; en `priority.test.ts` los
  cuatro casos se van con la función.
- **Coste:** 7 líneas.
- **Aviso:** es el único de la orden A que borra una función *correcta*. Si se prefiere darle un
  consumidor en vez de borrarla, eso es la orden B — pero **no se queda como está**.

### A5 · `envelopeHasCorrelation` parsea la misma cadena dos veces

- **Arreglar:** `packages/adapter-sdk/src/shared-session/envelope.ts:60-68`. La función llama a
  `envelopeObject(text)` en `:64` y acto seguido a `isEnvelopeText(text)` en `:66`, que vuelve a
  llamar a `envelopeObject(text)` en `:52` sobre la misma cadena. Pasar el objeto ya parseado.
- **Prueba:** leído en el fichero; las dos llamadas son literales y sobre el mismo argumento.
- **Se rompe:** nada, si `isEnvelopeText` conserva su firma pública para el resto de callers.
- **Coste:** un parse por turno, en el camino caliente de la sesión compartida.

---

# ORDEN B · TERMINAR DE IMPLEMENTAR — aquí está el valor de verdad

Estas cinco **no son basura que se borra: son contratos a medio cablear**. Cada una es una bomba de
drift: hoy los números coinciden, y el día que uno cambie el otro lado no se entera y falla en
silencio. Esto es lo que más aporta de toda la auditoría.

### B1 · El contrato `notify` está triplicado — CONFIRMADO, y es la orden nº 1

- **Estado real, verificado:**
  - canónico: `packages/protocol/src/schemas/messages.ts:219-222` — `NOTIFY_KINDS`,
    `EgressHandleSchema = /^[a-z][a-z0-9_.-]{0,63}$/`, `MAX_NOTIFY_BODY_BYTES = 4_096`
  - store `packages/store/src/repository/deliveries/contracts.ts`: **sí** importa `NOTIFY_KINDS` del
    protocolo (`:5`) pero copia a mano `maxNotifyBodyBytes = 4*1024` (`:121`) y
    `handlePattern` (`:124`)
  - SDK `packages/adapter-sdk/src/sdk/output-parser/contract.ts`: **no importa nada de
    `@cauce/protocol`**. Tiene su propio `MAX_NOTIFY_BODY_BYTES` (`:33`), su propio array
    `NOTIFY_KINDS` (`:35`) y su propio `CANONICAL_NOTIFY_HANDLE` (`:46`)
- **Hacer:** que `contract.ts` y el barrel `output-parser.ts` importen los tres del protocolo y
  borrar las copias. Igual con `handlePattern`/`maxNotifyBodyBytes` en el store.
- **Por qué importa más que borrar cosas:** ampliar `NOTIFY_KINDS` en el protocolo valida el POST
  `/v3/notify` pero **no llega al parser del SDK**, que descarta la directiva con un mensaje en
  castellano y sin error visible. El agente cree que notificó y no notificó.
- **Coste:** ≈ 23 líneas menos, y el drift cerrado.

### B2 · La misma cura, en tres sitios más

Mismo patrón, mismo commit si se quiere:

| Copia a mano | Canónico que debería importar |
|---|---|
| `adapter-sdk/src/sdk/client.ts:41-43` — `/^[a-z][a-z0-9_-]{0,63}$/u` sobre el alias | `AliasSchema` (`protocol/schemas/core.ts:7`), **regex byte a byte idéntica** |
| `adapter-sdk/src/sdk/output-parser/contract.ts:289-291` — `"agent.message" \|\| "agent.response" \|\| "agent.fanin"` | `AGENT_TO_AGENT_MESSAGE_TYPES` (`protocol/schemas/messages.ts:137`) |
| `store/src/repository/config/publish-policy.ts:24-29` — `reservedInternalMessageTypes: Set` | `RESERVED_INTERNAL_MESSAGE_TYPES` (`protocol/schemas/messages.ts:165`) |

La tercera es la peor: la constante del protocolo tiene **cero importadores externos**, mientras la
copia del store se usa en **10 sitios de 5 ficheros**. El contrato canónico está huérfano y el que
manda es una copia. Drift garantizado, no probable.

Contraste que lo delata: en el mismo SDK el `tenantId` **sí** usa el esquema canónico
(`TenantSchema.parse`, `bin/shared.ts:175`); el alias no.

### B3 · `mcp-fleet-monitor` acepta cualquier `estado` y devuelve cero filas

- **Corrección a la auditoría:** decía que `DELIVERY_STATUSES` es «declarativo pero muerto». **Es
  media verdad y hay que decirla entera.** El `inputSchema` se envía al cliente MCP en la lista de
  herramientas, así que **sí guía a quien llama**. Lo que no hace es defender el servidor.
- **Verificado:** `packages/mcp-fleet-monitor/src/server.ts:31` usa `Server` (el de bajo nivel).
  En `@modelcontextprotocol/sdk@1.29.0`, `dist/esm/server/index.js` tiene **0 ocurrencias** de
  `inputSchema` y **0** de `validateToolInput`; las 17 y 3 ocurrencias están en `server/mcp.js`
  (`McpServer`), que este servidor **no usa**. El handler solo hace
  `typeof args.estado === 'string'` (`:161`) y lo pasa a `d.status = $3`.
- **Verificado también:** `DELIVERY_STATUSES` (`:44`) reproduce los 8 valores de
  `DeliveryStateSchema` (`protocol/schemas/core.ts:73-75`) y el paquete **no declara
  `@cauce/protocol`** en su `package.json`.
- **Hacer, en este orden:** (1) validar `estado` contra el enum en el handler y devolver error, no
  cero filas; (2) declarar `@cauce/protocol` como dependencia e importar `DeliveryStateSchema`;
  (3) derivar `DELIVERY_STATUSES` de ahí en vez de copiarlo.
- **No hacer:** borrar el enum. Es el contrato que ve el cliente.

### B4 · Las 21 capabilities que se anuncian y nadie negocia — CONFIRMADO

Recorrí las 28 cadenas de `CAPABILITY_ENCODERS` (`adapter-sdk/src/sdk/client.ts:69-124`) contra
`packages/store/src` + `services/gateway/src` + `services/dispatcher/src`. **Solo 7 tienen lector**:
`harness.*`, `routing_targets_v1`, `agent_identity_v1`, `agent_profile_adoption_v1`,
`renewable_delivery_claims_v1`, `delegation_feedback_v1`, `agent_profile_v1`.

Las 21 restantes viajan en cada `hello`, las valida `HelloSchema`, se persisten en
`connection_leases.capabilities` y **nadie las lee jamás**:

`protocol.3.0`, `structured-output`, `stdin-prompt`, `durable-inbox`, `durable-outbox`,
`idempotent-delivery`, `heartbeat`, `cancellation.process-group`, `fencing-epoch`, `origin-relay`,
`attempt-scoped-delivery`, `event-id-correlation`, `claim-token-correlation`,
`authenticated-session-scope`, `attachments_v1`, `native_image_input_v1`,
`native_document_input_v1`, `persistent-sessions`, `loopback-api`, `stable-alias-sessions`,
`api-cancellation.abort-signal`.

> **Cuidado con dos falsos positivos**: un `rg` ingenuo de `heartbeat` y `origin-relay` da hits en
> el runtime, pero **ninguno lee la capability**: son la palabra suelta en
> `agent-documents/catalog.ts`, un `frame.type === 'heartbeat'` y un fichero llamado
> `origin-relay.js`. Los comprobé uno a uno.

- **Corrección a la auditoría:** decía que «`attachments_v1` y `native_*_input_v1` son las más
  urgentes porque el store adjunta por su cuenta». **Es falso.** `rg attachments` sobre
  `packages/store/src` y `services/gateway/src` da **cero hits**: el runtime no toca adjuntos. Viven
  en `telegram-bridge`, en el esquema del protocolo y en el SDK. No hay urgencia ahí.
- **Hacer:** por cada una de las 21, una decisión binaria escrita — **o le das lector server-side, o
  deja de anunciarse**. Anunciar una capacidad que nadie negocia entrena a leer `capabilities` como
  ruido, y el día que una importe nadie la va a mirar.
- **No hacer:** borrarlas en bloque sin decidir. Alguna puede ser el gancho de trabajo a medio
  terminar; eso hay que mirarlo cara a cara, no con un `sed`.

### B5 · Dos límites que miden lo mismo en unidades distintas

1. **`notify` body:** el protocolo mide UTF-16 (`z.string().max(4096)`,
   `messages.ts:232`), el store mide bytes UTF-8 (`Buffer.byteLength`,
   `agents/notifications.ts:455`). **Misma constante, distinta unidad**: para texto acentuado
   discrepan, y el borde entre 4096 caracteres y 4096 bytes es exactamente donde vive el fallo.
   Elegir UNA unidad y que la otra capa la importe.
2. **Alias del relay:** `services/terminal-relay/src/governance-relay.ts:46` usa
   `/^[a-z][a-z0-9_-]{1,63}$/u` — **mínimo 2 caracteres** — mientras `AliasSchema` acepta desde 1
   (`{0,63}`). **No es defensa en profundidad, es divergencia**: un alias de una letra pasa el
   gateway y lo rechaza el relay. El relay debe importar `AliasSchema`/`TenantSchema`.

---

# ORDEN C · NO TOCAR — falsos positivos verificados

Estos nueve estaban en la auditoría como sospechosos. **Los comprobé y no lo son.** Se documentan
aquí para que nadie los vuelva a «limpiar»: borrarlos abre agujeros.

### C1 · `validateDeliveryAdmission` — la premisa era falsa

La auditoría (ALTA-1) decía que sus dos comprobaciones per-field son duplicados de
`nonNegativeInteger` y que solo aporta la regla de suma. **Falso: tiene dos llamadores.**

- `services/gateway/src/config.ts:96` — vía `configuredDeliveryAdmission`, que sí pre-valida.
- `services/gateway/src/app.ts:309` — **construcción programática**, `options.admission ?? {...}`,
  que **no pasa por `nonNegativeInteger`**.

En ese segundo camino las comprobaciones per-field son lo único que hay. Quitarlas deja el arranque
programático del gateway sin validar. **Dejar como está.**

### C2 · `assertReplayAuthorization` — es una comprobación de autorización, no un duplicado

La auditoría (MEDIA-2) proponía rebajarla por «informacionalmente redundante» tras el `FOR UPDATE`.
**Tiene dos llamadores**, no uno: `outbox/operator.ts:192` (el que la auditoría miró) y
`deliveries/control.ts:74` (que no miró). Y aunque fuese redundante en un camino, el listón para
borrar un control de autorización de replay cross-tenant no es «parece redundante». **No tocar.**

### C3 · Los 24 esquemas «sin importadores» no son huérfanos

Comprobé los 24 de MEDIA-9 uno a uno: **todos tienen entre 2 y 8 usos dentro de
`packages/protocol/src`**. Son los bloques con los que se componen los esquemas de nivel superior
que sí se consumen. Que nadie los importe *desde fuera* es lo normal en una librería de esquemas.
**No es hallazgo.** Los únicos interesantes —`EgressHandleSchema`, `NotifyKindSchema`— ya están en
B1, y el problema ahí no es que sobren: es que **el consumidor mantiene una copia en vez de
importarlos**.

### C4 · Defensa en frontera de confianza — se queda

| Sospechoso | Por qué se queda |
|---|---|
| `parseDlqResolution` (gateway) vs el store (MEDIA-1) | El store **no debe** confiar en que el gateway validó: son procesos distintos y el store es la última línea |
| `materializeAttachments` (MEDIA-3) | Lo que de verdad hace —`contentMatches` con magic bytes, `validUtf8Text`, recálculo del sha256— **no está duplicado en ningún esquema**. La parte solapada (`safeName`, allowlist MIME) es barata y está en una frontera |
| `assertLongLivedConsumer` (MEDIA-8) | Es tautológica **para un implementador TypeScript**, y eso es justo lo que no garantiza una API pública: un consumidor JS puede pasar cualquier objeto. El cast `as Partial<>` es la señal de que se sabe |

### C5 · Los que no son «inconexos» sino otra cosa

- **MEDIA-4** (`profile-runtime-adoption.ts:20` vs el `.refine()` de `realtime.ts:93-96`):
  **confirmé que son byte a byte idénticos**. Lo que NO comprobé es si el guard corre sobre datos
  que siempre pasaron por el esquema. Sin eso no se puede ordenar el borrado. **Pendiente de una
  comprobación, no de una decisión.**
- **MEDIA-14** (telegram, chunk de 4 096): los dos extremos miden **code points**, así que las
  unidades coinciden. La sospecha real es otra: la conversión a HTML ocurre **después** de trocear y
  añade etiquetas. **Es un bug latente plausible, no una validación inconexa.** No lo reproduje.
- **MEDIA-15** (`MAX_REQUEST_BYTES` del relay vs `client_max_body_size` de nginx): **no verificable
  desde este árbol**, la configuración de nginx no está versionada aquí. Se queda como pregunta
  abierta para quien tenga acceso al despliegue.

---

# El patrón sistémico, que es el hallazgo de verdad

El protocolo canónico vive en `@cauce/protocol` y los consumidores reales lo **duplican por
copia-pega** en vez de importarlo. Eso produce las dos mitades de la orden:

1. **Huérfanos que se acumulan en el paquete canónico** → ORDEN A. Constantes que nadie lee porque
   el consumidor se hizo su copia. Son 48 líneas y se van hoy.
2. **Drift silencioso viviendo en los consumidores** → ORDEN B. Y esta es la mitad que importa:
   el día que el protocolo cambie, el SDK descarta directivas **sin error visible**, el store
   publica tipos que el protocolo reserva, y el relay rechaza alias que el gateway acepta.

Borrar la orden A sin hacer la B deja el repo más limpio y exactamente igual de frágil.

---

# Cómo verificar cada orden

```bash
# A1  debe seguir dando UN solo hit, y en client.ts
rg "outside the Cauce V3 schema"
# A2/A3/A4  deben dar 0 fuera de tests tras el borrado
rg "PREFLIGHT_ACK_ERROR_CODES|NON_HUMAN_DELIVERY_MESSAGE_TYPES|isHumanPriority"
# B1/B2  el consumidor tiene que importar, no copiar
rg "@cauce/protocol" packages/adapter-sdk/src/sdk/output-parser/contract.ts
rg "handlePattern|maxNotifyBodyBytes" packages/store/src/repository/deliveries/contracts.ts
# B4  ninguna capability anunciada sin lector
rg -c "<capability>" packages/store/src services/gateway/src services/dispatcher/src
```

Gate obligatorio en cada commit: `pnpm typecheck && pnpm lint && pnpm test:unit`.

# Qué NO se hizo en esta validación

- **No se ejecutó ningún test ni se tocó una línea de código.** La validación es lectura y `rg`.
- **No se comprobó MEDIA-4** (si el guard de adopción corre siempre sobre datos ya validados por el
  esquema). Sin eso no hay orden.
- **No se reprodujo MEDIA-14** (el desbordamiento del chunk de Telegram tras convertir a HTML).
- **No se pudo mirar MEDIA-15**: la configuración de nginx no vive en este repositorio.
- **No se decidió nada sobre las 21 capabilities.** Esa es una decisión de producto por cada una, y
  darla hecha desde una auditoría sería inventarla.
