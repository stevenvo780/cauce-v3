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
  Permiso `route` vigente en la base de datos. Responde 201 `{ sha256, bytes, media_type, name,
  blob, uri }`. Una repetición idéntica dentro del mismo tenant conserva los metadatos del primer
  upload; otro tenant puede subir esos mismos bytes y obtiene su propia fila y metadatos con 201.
  Un fichero físico existente con tamaño incompatible nunca se reemplaza.
- `GET /v3/blobs/<sha256>` — streaming del blob entero o de un rango (`Range: bytes=a-b` → 206 con
  `Content-Range`), con `Content-Type`, `Content-Length`, `Content-Disposition` y `Accept-Ranges`.
  Permiso `read` vigente en la base de datos y fila propia del tenant o concesión vinculada a la
  entrega y al alias autenticado. Los demás reciben 404, sin bytes ni metadatos. Solo una lectura
  autorizada toca `blobs.last_used_at`. Conocer el digest no concede acceso. Una descarga concedida
  usa nombre y MIME neutros en HTTP para no revelar los metadatos privados del primer uploader;
  el adaptador conserva el nombre visible que viajó en la referencia.
- `blobs` se creó en 042; la migración 043 cambia su clave a `(tenant_id, sha256)` y añade
  `blob_delivery_grants`. La concesión se escribe en la misma transacción que una entrega ya
  autorizada, solo si el emisor posee la fila o una concesión previa. En publicación directa, un
  digest inventado aborta sin mensaje, entrega ni grant; en un resultado de agente se descarta
  solo la referencia y se conserva el texto y su ACK. La descarga concedida corresponde al alias receptor,
  no a todos los agentes de su tenant; el archivo físico sigue deduplicado por sha256.
- Volumen `blobs_data` montado en `/var/lib/cauce-v3/blobs` (la imagen crea la ruta como uid 1000
  porque el runtime es `read_only`).

## Adaptador (adapter-sdk)

- Al recibir: `materializeAttachments` descarga cada entrada `blob:` de `attachments_v1` y cada ref
  `cauce-blob:` de `artifacts_v1` al directorio del turno (streaming a disco, digest y tamaño
  verificados) y las presenta al arnés como cualquier adjunto (`local_path`). Comparten el tope de
  4 adjuntos por mensaje; los bytes inline siguen limitados a 10 MB agregados. El parser común de
  protocolo rechaza un artefacto que mezcle `blob` y `uri` o declare un digest distinto; el bus y
  el adaptador leen exactamente el campo que corresponde a esa forma antes de conceder o descargar.
- Al responder: `inlineLocalArtifacts` sube un `file://` mayor que 10 MB (y ≤ techo) con
  `BlobClient.upload` y publica `{ name, uri: cauce-blob:…, media_type, sha256, size }`. Sin cliente
  configurado, el artefacto queda como estaba (hoy: no viaja).
- `BlobClient.fromRelayUrl(CAUCE_RELAY_URL, { mutualTls, bearerTokenFile })` deriva `https://host:puerto`
  del `wss://` del relay y usa las mismas credenciales que el WebSocket. Lo configura `bin/shared.ts`.
- En el salto entre agentes (`delegated-attachments.ts`) una ref `cauce-blob:` conserva su tamaño
  (hasta el techo de blob) y su digest. Al delegar o devolver un resultado entre tenants, el bus
  concede la lectura al destinatario exacto después de validar la ruta; no publica una ref ajena.
  El fan-in toma artefactos solo de respuestas `agent.response` autorizadas y atribuibles a la
  rama; una continuación denegada conserva su diagnóstico, sin conceder sus blobs.

## Retención

`ops/scripts/purgar_blobs.py --dir /var/lib/cauce-v3/blobs --dias 30 --psql '<orden psql -tA>'`
sirve para auditoría de solo lectura. La purga con `--aplicar` queda deshabilitada hasta coordinar
de forma segura las lecturas, escrituras y eliminaciones concurrentes; no hay borrado automático
ni cron de purga. El volumen se alcanza desde el contenedor del gateway o con un montaje de solo
lectura. La auditoría agrega `MAX(last_used_at)` por digest físico cuando varios tenants lo usan;
una fila con grants no se borra mediante `forgetBlob`.

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

Pila (`deploy/deploy.sh`): migración 042 y luego 043, volumen y env del gateway. Con la API activa,
el respaldo de la instancia debe acreditar tabla, volumen y restauración aislada antes del deploy.
Bundle nuevo del
adaptador para toda la flota (`bus-v3-<fecha>-blobs`) rodado alias por alias: un adaptador viejo
que reciba una entrada `blob:` la rechaza como adjunto malformado. Reversión: los mensajes inline
siguen válidos; conservar tabla y volumen para los blobs ya publicados. `down/043` se niega si hay
grants o un digest usado por varios tenants; restaurar desde respaldo para una reversa de esquema.
