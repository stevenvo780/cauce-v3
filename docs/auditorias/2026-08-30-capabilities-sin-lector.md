# Las 21 capabilities que se anuncian y nadie negocia

**Para el dueño. Esto es una tabla de decisión, no un cambio.** No se ha borrado ni cableado
ninguna: cada fila es *o le das lector server-side, o deja de anunciarse*, y esa firma es suya.

## Qué se midió, y cómo

`packages/adapter-sdk/src/sdk/client.ts:69-124` (`CAPABILITY_ENCODERS`) anuncia **28** cadenas en
cada `hello`. Se buscó cada una, literal, en `packages/store/src`, `services/gateway/src` y
`services/dispatcher/src`, excluyendo tests, y después en todo el árbol.

**Sólo 7 tienen lector server-side**: `harness.*`, `routing_targets_v1`,
`renewable_delivery_claims_v1`, `delegation_feedback_v1`, `agent_identity_v1`, `agent_profile_v1`,
`agent_profile_adoption_v1`. Confirma lo que dejó `2026-08-29-validaciones-inconexas.md` ORDEN B4;
verificado de nuevo contra el árbol el 30-08-2026 y sigue igual.

Las otras **21** viajan en cada `hello`, se persisten en `connection_leases.capabilities`
(`packages/store/src/repository/deliveries/claims.ts:87-115`) y **nadie las lee jamás** para decidir
nada. Un `grep` ingenuo da falsos positivos en tres: `heartbeat` (8 aciertos, todos
`frame.type === 'heartbeat'` o el `kind` de un documento de agente), `origin-relay` (8, la ruta
`/v3/console/origin-relays` y un fichero homónimo) y `structured-output` (1, un comentario). Se
miraron uno a uno; ninguno negocia la capability.

## Las 21

Coste estimado en la última columna: **retirar** = quitar la línea del encoder y del tipo, más el
rodaje de que ningún adaptador desplegado la exija; **cablear** = escribir el lector que hoy no
existe.

| # | Capability | Qué promete | Estado real | Cumplirla / retirarla |
|---|---|---|---|---|
| 1 | `protocol.3.0` | La versión de protocolo que habla el adaptador | El gateway nunca compara versiones | **La única con valor propio.** Cablear un lector que rechace un `hello` de versión incompatible es barato y es lo que evita el fallo mudo el día que haya 3.1 |
| 2 | `structured-output` | El arnés devuelve sobre estructurado | Incondicional en el SDK; el gateway lo parsea siempre | Retirar: describe algo que ya no es opcional |
| 3 | `stdin-prompt` | Acepta el prompt por stdin | Detalle interno del arnés, invisible al servidor | Retirar |
| 4 | `durable-inbox` | Bandeja de entrada durable en disco | Propiedad del adaptador; el servidor no cambia nada por ella | Retirar, o cablear si se quiere condicionar el reenvío tras reconexión |
| 5 | `durable-outbox` | Bandeja de salida durable | Ídem | Ídem que 4 |
| 6 | `idempotent-delivery` | Deduplica por `event_id` | El store deduplica siempre, lo declare o no | Retirar |
| 7 | `heartbeat` | Emite latidos | El frame `heartbeat` se acepta de todos por igual | Retirar |
| 8 | `cancellation.process-group` | Cancela matando el grupo de procesos | Local; V3 no tiene frame de cancelación remota | Retirar |
| 9 | `fencing-epoch` | Respeta el fencing por época | El gateway lo impone a todos, no lo pregunta | Retirar |
| 10 | `origin-relay` | Sabe reenviar al canal de origen | El worker de `origin_relay` filtra por adaptador, no por capability | Retirar, o cablear en el filtro del worker si se quiere que el encolado la respete |
| 11 | `attempt-scoped-delivery` | Entiende entregas con ámbito de intento | Invariante del store para todos | Retirar |
| 12 | `event-id-correlation` | Correlaciona por `event_id` | Obligatorio en el esquema | Retirar |
| 13 | `claim-token-correlation` | Correlaciona por `claim_token` | Obligatorio; el ACK sin token se rechaza | Retirar |
| 14 | `authenticated-session-scope` | Entiende `authenticated_context` | El gateway lo adjunta siempre que existe | Retirar |
| 15 | `attachments_v1` | Acepta adjuntos en el cuerpo | **El caso más incómodo.** `telegram-bridge/src/ingress-body.ts:258` mete `attachments_v1` en el cuerpo y `adapter-sdk/src/sdk/engine/delivery-context.ts:30` lo lee — pero **nadie comprueba que el destinatario la anunciara** | Cablear: el emisor tiene que mirar la capability antes de meter adjuntos, o degradar a texto. Retirarla sería mentir sobre algo que sí viaja |
| 16 | `native_image_input_v1` | Acepta imágenes nativas | Se activa por arnés (`harnesses/shared/prompt.ts:34`, sólo codex) y sólo se usa del lado del SDK | Mismo caso que 15, un escalón menos urgente |
| 17 | `native_document_input_v1` | Acepta documentos nativos | Sólo declarada en el tipo; ni productor ni lector | Retirar: hoy no la enciende nadie |
| 18 | `persistent-sessions` | Mantiene sesión entre entregas | Es la única `boolean` (no `true`) del tipo: se anuncia también cuando es `false` | Retirar, o cablear si el reparto debe preferir agentes con sesión viva |
| 19 | `loopback-api` | Expone API de vuelta al propio agente | Sin lector en ningún lado | Retirar |
| 20 | `stable-alias-sessions` | Sesiones estables por alias | Sin lector | Retirar |
| 21 | `api-cancellation.abort-signal` | Cancela por `AbortSignal` | Local al SDK | Retirar |

## Lo que hay que decidir, en una línea

De las 21, **una merece lector** (`protocol.*`, para no fallar mudo ante una versión futura), **dos
describen algo que sí viaja sin negociarse** (`attachments_v1`, `native_image_input_v1`, y ahí el
riesgo es real: se envían adjuntos a quien no dijo aceptarlos) y **las otras 18 describen
comportamiento incondicional o puramente local**: anunciarlas entrena a leer `capabilities` como
ruido, y el día que una importe nadie la va a mirar.

**No se ha borrado ninguna.** Alguna puede ser el gancho de trabajo a medio terminar, y eso se mira
cara a cara, no con un `sed`.
