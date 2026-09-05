# Ficheros grandes por referencia (blobs)

## Qué cambia

Hasta 10 MB un adjunto sigue viajando inline (`attachments_v1[].content_base64`), exactamente como
antes. Por encima, el fichero viaja **por referencia**: los bytes viven en el almacén de blobs del
gateway, direccionados por su sha256, y el mensaje sólo lleva el digest.

- `attachments_v1[]` admite una entrada `{ kind, name, mime_type, file_size, blob: "sha256:<hex>" }`
  sin base64 (`AttachmentBlobReferenceSchema`, `packages/protocol/src/schemas/messages.ts`).
- Un artefacto de agente (`output.artifacts[]`) admite `uri: "cauce-blob:sha256:<hex>"` con `size`,
  `media_type` y `sha256`; `isDeliverableArtifactUri` lo cuenta como entregable.
- Techo de cable: `MAX_BLOB_BYTES` (16 GiB). Tope del gateway: `CAUCE_BLOB_MAX_BYTES` (2 GiB por
  defecto), nunca por encima del techo.

## Gateway

- `PUT /v3/blobs` — cuerpo `application/octet-stream`, cabeceras `X-Cauce-Blob-Name` (obligatoria,
  nombre de fichero seguro), `X-Cauce-Blob-Media-Type` (opcional), `X-Cauce-Blob-Sha256` (opcional;
  409 si no cuadra). Se escribe en streaming a `CAUCE_BLOB_DIR/tmp/<uuid>` calculando el sha256 al
  vuelo y se renombra a `CAUCE_BLOB_DIR/<sha256>`. Un `Content-Length` por encima del tope se
  rechaza antes de leer (413); un cuerpo chunked se corta en el tope sin dejar fichero parcial.
  Permiso `route`. Responde 201 `{ sha256, bytes, media_type, name, blob, uri }`.
- `GET /v3/blobs/<sha256>` — streaming del blob entero o de un rango (`Range: bytes=a-b` → 206 con
  `Content-Range`), con `Content-Type`, `Content-Length`, `Content-Disposition` y `Accept-Ranges`.
  Permiso `read`. Cada lectura toca `blobs.last_used_at`. Un digest es una capacidad: quien lo
  nombra (llegó en un mensaje que ya cruzó la arista) puede leerlo, sea del tenant que sea.
- Tabla `blobs` (migración 042): `sha256, bytes, media_type, name, tenant_id, created_by,
  created_at, last_used_at`. Idempotente por digest; otro tamaño bajo el mismo digest es `conflict`.
- Volumen `blobs_data` montado en `/var/lib/cauce-v3/blobs` (la imagen crea la ruta como uid 1000
  porque el runtime es `read_only`).

## Adaptador (adapter-sdk)

- Al recibir: `materializeAttachments` descarga cada entrada `blob:` de `attachments_v1` y cada ref
  `cauce-blob:` de `artifacts_v1` al directorio del turno (streaming a disco, digest y tamaño
  verificados) y las presenta al arnés como cualquier adjunto (`local_path`). Comparten el tope de
  4 adjuntos por mensaje; los bytes inline siguen limitados a 10 MB agregados.
- Al responder: `inlineLocalArtifacts` sube un `file://` mayor que 10 MB (y ≤ techo) con
  `BlobClient.upload` y publica `{ name, uri: cauce-blob:…, media_type, sha256, size }`. Sin cliente
  configurado, el artefacto queda como estaba (hoy: no viaja).
- `BlobClient.fromRelayUrl(CAUCE_RELAY_URL, { mutualTls, bearerTokenFile })` deriva `https://host:puerto`
  del `wss://` del relay y usa las mismas credenciales que el WebSocket. Lo configura `bin/shared.ts`.
- En el salto entre agentes (`delegated-attachments.ts`) una ref `cauce-blob:` conserva su tamaño
  (hasta el techo de blob) y su digest.

## Retención

`ops/scripts/purgar_blobs.py --dir /var/lib/cauce-v3/blobs --dias 30 --psql '<orden psql -tA>'`
informa; con `--aplicar` borra filas y ficheros no leídos en N días, ficheros huérfanos con N días
sin tocar, y temporales de más de 24 h. Sin cron todavía: hay que programarlo en el host
(el volumen se alcanza con `docker run --rm -v cauce-v3-prod_blobs_data:/blobs …` o desde el
contenedor del gateway).

## Paso 5, pendiente: Telegram por encima de 20 MB

El Bot API público entrega por `getFile` como mucho 20 MB y sube por `sendDocument` hasta 50 MB:
son topes de Telegram, no nuestros. Para ficheros de 1 GB por Telegram hace falta el **Local Bot
API Server** (`telegram-bot-api`, imagen `aiogram/telegram-bot-api`) en modo `--local`:

1. Un contenedor `telegram-bot-api` en la pila con `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` (los da
   my.telegram.org; es una decisión del dueño) y un volumen de datos.
2. El bridge apunta su `api_base` a `http://telegram-bot-api:8081` y llama a `logOut` en el Bot API
   público antes de migrar cada bot (Telegram exige cerrar la sesión en la nube).
3. En modo local `getFile` devuelve una RUTA de disco (hasta 2 GB): el bridge la lee en streaming,
   la sube como blob (`PUT /v3/blobs`) cuando pasa de 10 MB y publica la entrada `blob:`.
4. Egreso: un artefacto `cauce-blob:` se baja del gateway a disco y se envía con `sendDocument`
   (hasta 2 GB en local) usando la ruta local; hoy el bridge no renderiza `cauce-blob:` y un
   `done` con sólo ese artefacto no llega al chat.
5. Prueba por efecto obligatoria: un fichero real de 1,2 GB de Telegram a un alias y de vuelta al
   chat con el mismo sha256 en los dos extremos.

## Despliegue

Pila (`deploy/deploy.sh`): migración 042, volumen nuevo, env nuevo del gateway. Bundle nuevo del
adaptador para toda la flota (`bus-v3-<fecha>-blobs`) rodado alias por alias: un adaptador viejo
que reciba una entrada `blob:` la rechaza como adjunto malformado. Reversión: los mensajes inline
siguen válidos; `down/042_blobs.sql` retira la tabla.
