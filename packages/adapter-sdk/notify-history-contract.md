# Consumidor de historial notify

## Estado de integración

El SDK consume el contrato comunicado del backend d374e476ce1bb6a07386b8fccf3fc6880e56a791, de Zeus. Ese commit no está en el remoto accesible desde este checkout: `git fetch origin d374e476ce1bb6a07386b8fccf3fc6880e56a791` devuelve `not our ref`; la API de GitHub devuelve HTTP 422 y vpstn no resuelve. No se ha transferido, importado su exportación común ni probado su handler real. No se escribió backend ni un DTO alternativo en protocol. La prueba HTTP local verifica el contrato comunicado y el pipeline del SDK; no sustituye el E2E con el código de Zeus.

## Recorrido productivo del consumidor

`src/bin/shared.ts` instala HttpEgressReceiptSource con la identidad del runtime y el transporte HTTP autenticado existente. AdapterClient lo pasa al engine. Antes del harness, noticeHistoryFor toma exclusivamente el origen autenticado de la nueva entrega humana y consulta los IDs del historial durable. DurableStore incluye registros terminales archivados después de reiniciar, sin depender del origin del generador; el intento actual prevalece sobre cualquier cuerpo archivado anterior. HarnessAdapter entrega la selección a protocolPrompt como datos separados de instrucciones y autorización.

## Ruta y evidencia

GET `/v3/agent/egress?delivery_ids=uuid,uuid`, lotes de 1 a 20 IDs deduplicados. Tenant y alias sólo provienen de la autenticación, no del query ni del origin generador. El lector está ligado a esa misma identidad y rechaza un scope distinto antes del HTTP. La respuesta contiene requested e items; cada item debe pertenecer al lote solicitado. requested es metadata del servidor, no una fuente de autorización.

El lector proyecta source_delivery_id, source_attempt, notify_index, notification_id, kind y destination (handle, adapter, channel, conversation_id) a la selección local. Conserva los estados públicos exactos: sent, partial, pending, ambiguous, dead, denied, unconfirmed y unknown. prepared/sending se rechazan. No inventa asociaciones de efectos con índices de chunk: utiliza los agregados acreditados chunks.expected/chunks.sent, effect_ids y provider_message_ids; provider_message_id singular sirve sólo si el servidor declara sent.

Sent exige total esperado conocido, todos los chunks enviados, IDs de proveedor distintos y evidencia de efectos. Partial puede identificar el aviso al responder a uno de sus fragmentos, manteniendo estado partial: no afirma recepción completa. Cualquier fragmento de un envío completo puede resolver reply_to. IDs de notificación reutilizados en bindings distintos o snapshots contradictorios son ambiguous, sin última-gana. Un recibo de otro intento nunca se pega al cuerpo actual.

Un destino ausente o no acreditado excluye el cuerpo y queda reflejado en unclassified; no elimina otros avisos válidos del mismo lote. Para un hilo sin evidencia equivalente en el DTO, el consumidor no atribuye un aviso de la conversación general al hilo.

Las búsquedas incluyen los registros archivados para poder encontrar reply_to antiguos. La recencia se determina por sent_at o created_at del recibo, no por orden del array. Un reply_to desconocido no elige por proximidad. El lookup completo tiene límite de 1500 ms y respeta cancelación; errores o respuestas inválidas dejan source=unavailable, sin cuerpos. Con historiales que no se puedan consultar dentro de ese límite, no se simula completitud: no se incorpora historia.

## Presupuesto y pruebas

El presupuesto cubre el bloque UTF-8 serializado entero: delimitadores, metadata, JSON escapado y avisos de truncación. Los cuerpos se truncan por puntos de código. El título y las instrucciones del bloque distinguen generado de enviado.

La fixture mantiene el ID c137560e-ca62-46b2-89bb-b59947953547, ausencia de origin, un notify y destino Telegram 6979524541/provider 2703 del incidente comunicado. El cuerpo es sintético: no se leyó el inbox real. Las pruebas ejercitan HTTP de contrato → engine → almacén archivado y reabierto → harness → prompt; además, lotes, identidad, destinatarios múltiples, intentos, estados, fragmentos, ambigüedad y presupuesto.

Pendiente: transferir el commit original sin alterarlo, reconciliar con el DTO común exportado y ejecutar estos controles contra su handler real. La entrega previa b810dae4 tampoco fue recuperable; esta implementación del SDK es independiente.

Reversión: revertir exclusivamente el commit o los cambios de esta entrega. No hay cambio de esquema ni estado externo.
