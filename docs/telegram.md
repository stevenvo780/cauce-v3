# Puente Telegram

Canal de integración bidireccional con la Bot API de Telegram. Es el canal de entrada más utilizado en producción (~12 000 mensajes entrantes frente a 1 desde consola).

Para contexto arquitectónico véase [arquitectura.md](arquitectura.md); para operación en producción véase [operacion.md](operacion.md).

## Ingreso (Telegram → Cauce)

| Aspecto | Comportamiento |
|---|---|
| Polling | Lease cercado en BD (`channel_bridge_leases`: owner + epoch). Un segundo poller recibe `fenced`; nunca hay dos activos simultáneamente. |
| Cursor | Durable. Reiniciar antes de persistir el cursor no duplica mensajes (retry key estable). |
| Política | Updates rechazados por política avanzan el cursor pero **nunca** ingresan a Cauce. |
| Identidad | `origin`, `session`, `conversation` y `external message` se derivan exclusivamente del update recibido. |

## Egreso (Cauce → Telegram)

Idempotente mediante tabla `telegram_egress_effects` que registra cada chunk como `sent` o `ambiguous`.

- Texto limitado a 65 536 caracteres, dividido en mensajes de hasta 4 096 caracteres.
- Cada chunk transita por estados durables: `prepared → sending → sent | ambiguous | dead`.
- ACK global `sent` se rechaza salvo que **todos** los chunks estén confirmados como `sent`.
- **429**: chunk vuelve a `prepared` respetando `retry_after`.
- **Timeout / respuesta ambigua**: chunk queda `ambiguous`, sin reintento automático.
- Telegram no ofrece clave de idempotencia. Si el proceso cae tras `sending`, al reiniciar el chunk pasa a `ambiguous` → outbox `dead` → nunca se repite.

### Replay manual

Solo mediante `manualReplayEffect()`. Requisitos:

1. Efecto en estado `ambiguous` o `dead`, outbox `dead`.
2. Hash exacto del efecto y evidencia de incidente (SHA-256).
3. Permiso `allow_control` y flag `duplicateRiskAcknowledged=true`.

## Adjuntos (entrantes)

- **Cualquier formato.** No hay lista de tipos admitidos: entran fotos, documentos, vídeos y animaciones, con la extensión que sea o sin ninguna. Se toma `photo`, `document`, `video` y `animation`; `voice`, `audio` y `video_note` van a transcripción y, si entran en el tope inline, también como adjunto (ver notas de voz).
- Lo que se valida es **identidad e integridad, nunca el tipo**: nombre seguro (sin traversal, sin bidi ni invisibles), ruta remota segura, concordancia entre tamaño declarado y descargado, sha256 y base64 canónico.
- El tipo se deduce de los **bytes** primero, de lo que declara Telegram después y de la extensión al final; lo que nadie reconoce viaja como `application/octet-stream`. El parámetro `; charset=…` se recorta.
- `kind: image` se marca **solo si los bytes son una imagen ráster** (JPEG, PNG, WebP, GIF). Un `image/svg+xml` o un HEIC entran como documento: ese campo decide si un arnés puede pasar el fichero a una entrada nativa de imagen, y una imagen mentida cuesta el turno entero.
- **Dos techos distintos, y conviene no confundirlos.** La Bot API manda **un fichero por mensaje de Telegram**: un update trae como mucho una foto, un documento, un vídeo o una animación. El sobre de Cauce admite **hasta 4 adjuntos, 10 MB cada uno y 10 MB agregados**, y ese cupo se llena juntando updates (ver álbumes, abajo) o en el egreso. Telegram además no deja descargar más de 20 MB con `getFile` ni enviar más de 50 MB (10 MB si es foto) salvo contra un servidor Bot API propio.
- El contenido viaja en el body de entrega durable. El adaptador lo materializa en un directorio `0700` por entrega con ficheros `0600`, bajo `CAUCE_AGENT_WORKSPACE` o el temporal del sistema, y lo libera después de publicar el ACK. Del fichero solo está verificada su identidad: su contenido es dato no confiable.

## Álbumes (grupos de medios)

Un álbum son N updates que comparten `media_group_id`, y la Bot API admite un pie de foto por
miembro aunque lo habitual sea que sólo el primero lo lleve. Publicados de a uno costaban N entregas
y N turnos de modelo, y en modo `mention` sólo llegaba al agente el miembro con el pie: los demás no
estaban dirigidos a nadie, se contaban como `updates_unaddressed` y se tiraban.

Hoy un álbum entra como **un solo mensaje del bus con hasta 4 adjuntos**:

- El *buffer* se cierra por lo que ocurra primero: un update ajeno, llegar a 4 miembros, o
  asentarse — que no haya llegado ningún miembro nuevo en este ciclo de sondeo, o que hayan pasado
  **1 500 ms** desde el primero.
- Quien decide si el álbum está dirigido al alias es el **miembro con el pie de foto de entre los
  que pasan la lista blanca**: juzgar uno sin texto suprimiría el álbum entero, y elegir al del pie
  antes de filtrar dejaba que un miembro ajeno con pie tirara sin rastro a los permitidos.
- **Cada miembro pasa por la lista blanca por su cuenta.** `media_group_id` es lo único que agrupa
  estos updates y viene de un payload sin validar, así que un miembro no es prueba sobre sus
  vecinos: se comprueban su `chat.id`, su `from.id` y su `message_id` contra la misma lista blanca
  del camino de un solo update, y además que coincidan con el principal del miembro primario. El que
  no pasa se descarta con su métrica —y con su línea de auditoría salvo que sea un `message` de un
  chat privado, donde no se emite— y no se publica nunca. Sin esto, un miembro ajeno se habría
  publicado bajo el chat, el usuario, la clave de sesión y el origen del primario: su foto cayendo
  en una conversación a la que nadie la mandó.
- **Un álbum más largo que un lote no pierde la dirección.** Un álbum llega hasta 10 miembros y el
  lote admite 4, así que los miembros 5-N llegan en un lote de continuación cuyo miembro con pie es,
  por fuerza, uno sin pie: resuelto por su cuenta no está dirigido a nadie y moriría como
  `updates_unaddressed`, que es justo la pérdida que este coalescedor existe para quitar, movida más
  allá del borde del lote.
- **El recuerdo del álbum no es una autorización.** `media_group_id` viene del mismo payload sin
  validar que todo lo demás, así que **cada lote se resuelve en vivo**, continuación incluida, y sólo
  se cae al recuerdo cuando la negativa viva es la ÚNICA que un miembro sin pie no puede evitar
  (`not_addressed`). La política del hilo, `sender_chat`, `via_bot`, `from.is_bot` y un pie dirigido
  a otro alias de la flota (`mention_unserved`) siguen juzgando a los miembros 5-N por su propio
  mensaje: un miembro que le escribe a otro bot se suprime con su motivo y su rastro, no viaja bajo
  el pie del primario. El hilo forma parte de la
  clave del recuerdo —grupo, chat, usuario e hilo—, y sólo cubre la continuación **inmediata**: un
  lote ajeno, un rechazo, la pérdida del lease o el apagado lo olvidan.
- **Ningún pie se pierde por caber.** El mensaje publicado lleva el pie de CADA miembro del álbum,
  en orden de update y separados por una línea en blanco: todos son del mismo chat, el mismo usuario
  y el mismo hilo, así que fusionar su texto no mueve nada. Antes viajaban los bytes de todos y sólo
  el texto del primario, sin rastro y sólo cuando el álbum cabía en un mensaje, de modo que llegar o
  no al agente dependía del cupo de bytes. Si la unión no cabe en el pie (1 024 caracteres, el tope
  de Telegram), el álbum se va al camino de a uno y cada miembro llega con el suyo entero.
- Si los cuatro juntos no entran en el cupo agregado del sobre, se publican de a uno. Es peor que
  un solo mensaje y mucho mejor que quedarse sin las fotos. **Nada se recorta**: un desbordamiento
  hace que el lote no «quepa» y lo manda a ese camino de a uno, así que un adjunto por encima del
  cupo se retrasa a su propio mensaje, nunca se descarta.

**El cursor es la parte delicada.** `getUpdates` avanza un offset durable y destructivo: pasado el
offset, un update no se puede volver a pedir desde ningún lado. Por eso un miembro en el *buffer*
**retiene el cursor** hasta que el mensaje fusionado está publicado de forma durable. No existe
«vaciar y olvidar»: o el lote llega a `publish` y recién entonces el cursor avanza, o el *buffer*
se **descarta** entero (apagado, pérdida del lease, error de sondeo) y el cursor sin avanzar hace
que Telegram vuelva a entregar el álbum completo. Los duplicados los ataja la clave de
idempotencia, que no depende del contenido; las pérdidas no las ataja nada.

## Updates que el sondeo no sirve

`getUpdates` pide sólo `message`, pero la suscripción es estado del servidor que un webhook u otro
despliegue pueden ensanchar. Un `edited_message`, un `channel_post` o un `edited_channel_post`
llegan, no se sirven, y **antes** de mover el cursor dejan constancia:

- una línea de auditoría con `reason: update_kind` y el `kind` concreto, emitida siempre antes de
  `advanceCursor` justamente porque el cursor es destructivo. En un grupo se llama
  `telegram_group_update_suppressed`, byte a byte como antes; en un chat privado es
  **`telegram_update_suppressed`**, porque un evento con «group» en el nombre describiendo un DM se
  lee mal en toda consulta posterior;
- la métrica **`updates_kind_suppressed`**, separada de `updates_denied`, que sigue contando los
  `message` rechazados por política.

## Notas de voz (entrantes)

- Se descargan y transcriben contra un servicio STT compatible con OpenAI.
- **El audio sí viaja por el bus.** La nota de voz, el audio y el videomensaje llegan **además** como
  adjunto `document` cuando el fichero entra en el tope inline de 10 MB: el nombre se deriva del
  formato detectado en los bytes y la transcripción nunca reemplaza al fichero. Un audio típico está
  muy por debajo de ese tope, así que viajar es el caso normal, no la excepción.
- **Dos techos distintos.** Se descargan hasta 25 MB para transcribir y viajan hasta 10 MB inline.
  Sólo se descarta el fichero que queda entre uno y otro: ahí sobrevive únicamente la transcripción.
- Formato detectado desde bytes: Ogg, WAV, FLAC, MP3, ISO-BMFF, WebM.
- El texto transcrito llega en `body.prompt` con prefijo `[nota de voz transcrita]`.
- Si la transcripción falla, el mensaje llega con una explicación que pide al agente solicitar texto.
- La configuración del servicio STT se valida al arranque, no en el primer audio.

## Redacción de secretos

Las reglas viven en `@cauce/protocol` y las comparten los puntos que redactan; el interruptor es un
parámetro, nunca una lectura de entorno hecha dentro de la regla.

| Punto | Variable | Por defecto |
|---|---|---|
| Ingreso del puente | `CAUCE_TELEGRAM_REDACT_INGRESS` | **apagado** |
| Punto único de publicación del gateway | `CAUCE_REDACT_PUBLISH` | **encendido** |
| Cuerpo delegado de agente a agente, en el store | sin interruptor | **siempre** |

Cuando el ingreso del puente redacta algo, el cuerpo lleva `redacted_v1` con el recuento y las
familias encontradas (claves privadas, credenciales en URI, `Authorization`, *bearer*, token de bot
de Telegram, JWT y claves de API de los proveedores habituales). Los otros dos puntos no marcan el
cuerpo: el gateway deja la línea `publish_secret_redacted` y el store `delegated_body_unscanned`
en el registro, y nada más.

Tres detalles del punto de publicación, porque de ellos depende que no refuse nada:

- **Las dos patas de la publicación en dos fases de la consola llaman al mismo ayudante** sobre el
  mismo cuerpo enviado, así que el hash semántico que el store prepara y el que después verifica se
  calculan sobre los mismos bytes. Aplicarlo en una sola pata convertía cada mensaje con forma de
  secreto en un 409 permanente.
- Reescribir un nombre de adjunto lo **alarga** (`bearer <token>` crece por cada acierto), así que
  después de redactar el nombre se recorta al tope del protocolo por frontera de punto de código y
  el cuerpo se vuelve a validar contra el esquema. Un fallo se registra; nunca se rechaza la
  publicación.
- Lo que la redacción **no llegó a mirar** se dice. Son tres cotas, no una: la longitud de un valor
  (1 MiB), el presupuesto de nodos del recorrido (100 000) y el **presupuesto agregado de caracteres
  por cuerpo** (4 MiB), que es el único que acota el coste total —un cuerpo con muchos valores
  grandes multiplica los otros dos y compraba segundos del bucle de eventos compartido—. Lo que
  queda fuera viaja tal cual y sale una línea con el recuento y **todas** las cotas que saltaron, no
  sólo la primera: informar de un punto ciego escondiendo el otro no es informar. Un saneador que no
  sabe nombrar su propio punto ciego no es uno.

El cuerpo delegado se redacta en el store porque ese camino de publicación no pasa por el punto
único del gateway: la salida de un agente aterriza en `messages.body` directo desde SQL, y la
salida de un agente nunca es un portador legítimo de secretos —un secreto viaja por el plano
sellado (ver [ADR-007](adr/007-traspaso-sellado-de-secretos.md)).

**La redacción mira sólo valores de TEXTO.** `content_base64` está explícitamente fuera del
recorrido: son megabytes de bytes ya validados por firma donde ninguna regla encontraría nada. La
consecuencia hay que decirla entera: **un `.pem` mandado como fichero se guarda literal en
`messages.body`**, y lo mismo vale para los bytes de una nota de voz, que llegan ahí como adjunto
`document`. Ese punto ciego es deliberado, no un olvido.

## Señales visuales

Best-effort: 👀 al aceptar, 🤔 + typing mientras procesa, 👍/👎 al terminar. Un fallo en estas llamadas **nunca** afecta operaciones durables.

## Configuración

| Variable / recurso | Descripción |
|---|---|
| `CAUCE_TELEGRAM_CONFIG_FILE` | JSON externo con IDs operativos (sin tokens). |
| `token_file` | Archivo regular, no symlink, propiedad del usuario del proceso, modo `0600`. Token **nunca** inline ni en variable de entorno. |
| `CAUCE_TELEGRAM_ALIASES` | Arranque incremental (lista separada por comas). |
| Marcador de shutdown V2 | Obligatorio; sin él el bridge falla cerrado. |

Scripts de soporte: `ops/scripts/generate-telegram-config.py` (generación) y `ops/scripts/telegram-cutover-preflight.py` (preflight).

## Enrutamiento de grupos (`chats[]` / `bot_username`)

| Valor de `chats` | Efecto |
|---|---|
| Ausente | Modo legacy (sin cambios). |
| `[]` | Scoped, default-deny. |
| `[{…}]` | Scoped por chat. |

Modos por chat: `mention` (por defecto), `always` (host ambiental), `off`.

Tabla completa de precedencia (P0–P10) en [`CONFIGURATION.md`](../services/telegram-bridge/CONFIGURATION.md).

## Health

- `/health/live` y `/health/ready` reflejan progreso real, no son estáticos.
- 3 errores consecutivos eliminan readiness. PostgreSQL es requisito para `ready`.
