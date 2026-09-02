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

- **Cualquier formato.** No hay lista de tipos admitidos: entran fotos, documentos, vídeos y animaciones, con la extensión que sea o sin ninguna. Se toma `photo`, `document`, `video` y `animation`; `voice`, `audio` y `video_note` siguen yendo a transcripción.
- Lo que se valida es **identidad e integridad, nunca el tipo**: nombre seguro (sin traversal, sin bidi ni invisibles), ruta remota segura, concordancia entre tamaño declarado y descargado, sha256 y base64 canónico.
- El tipo se deduce de los **bytes** primero, de lo que declara Telegram después y de la extensión al final; lo que nadie reconoce viaja como `application/octet-stream`. El parámetro `; charset=…` se recorta.
- `kind: image` se marca **solo si los bytes son una imagen ráster** (JPEG, PNG, WebP, GIF). Un `image/svg+xml` o un HEIC entran como documento: ese campo decide si un arnés puede pasar el fichero a una entrada nativa de imagen, y una imagen mentida cuesta el turno entero.
- **Máximo 10 MB por adjunto y 10 MB agregados, 4 por mensaje.** Es hoy la única limitación real. Telegram además no deja descargar más de 20 MB con `getFile` ni enviar más de 50 MB (10 MB si es foto) salvo contra un servidor Bot API propio.
- El contenido viaja en el body de entrega durable. El adaptador materializa en un directorio privado `/tmp` con permisos `0600`; se limpia tras la ejecución. Del fichero solo está verificada su identidad: su contenido es dato no confiable.

## Notas de voz (entrantes)

- Se descargan y transcriben contra un servicio STT compatible con OpenAI; el audio se descarta (nunca viaja por el bus).
- Hasta 25 MB. Formato detectado desde bytes: Ogg, WAV, FLAC, MP3, ISO-BMFF, WebM.
- El texto transcrito llega en `body.prompt` con prefijo `[nota de voz transcrita]`.
- Si la transcripción falla, el mensaje llega con una explicación que pide al agente solicitar texto.
- La configuración del servicio STT se valida al arranque, no en el primer audio.

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
