# Meta: conexión OAuth renovable y autorización comprensible

## Resultado buscado

Cauce permite que el cliente renueve sus tokens de acceso sin pedir otro consentimiento durante la vigencia autorizada. La conexión de Steven debe volver a funcionar desde su dot y demostrar publicación durable y respuesta correlacionada de Jarvis. La pantalla de autorización debe resultar legible en escritorio y móvil y explicar destino, permisos, duración y revocación.

## Comportamiento preparado

- Tokens de acceso de hasta cinco minutos; autorizaciones nuevas de treinta días por defecto, con plazo configurable y fijo desde el consentimiento.
- Rotación del refresh token con un único sucesor durable. Durante los sesenta segundos de gracia existentes, un reintento devuelve ese sucesor si todavía no se ha consumido. Emite otro token de acceso corto tras revalidar toda la autoridad.
- Recuperación después de pérdida de respuesta y reinicio: el sucesor se deriva mediante HMAC con la clave de firma existente y separación por versión, issuer, recurso, grant y hash anterior. PostgreSQL conserva únicamente hashes. No hay nuevas claves persistentes ni caché como autoridad.
- Reutilización fuera de la gracia: revocación del grant completo. Dentro de la gracia, un sucesor ya consumido o inexistente se rechaza; no se avanza por cadenas de tokens antiguos.
- Cada renovación y recuperación verifica cuenta, sello de credencial, vínculo, membresía, tenant, alias, scopes, revocación y vencimiento. La renovación no extiende el grant.
- Compatibilidad con `ui_locales`, enviado por ChatGPT. La pantalla sigue en español; la preferencia no modifica la autoridad ni se inserta en el HTML.
- Pantallas de entrada, sesión, consentimiento y autorizaciones con CSS local permitido por nonce CSP; sin recursos externos, permisos premarcados ni cambios de CSRF.

## Criterios de cierre

1. Pruebas con el SDK MCP real y PostgreSQL desechable: respuesta perdida después del commit, reinicio, concurrencia, replay, expiración, revocación y aislamiento de cliente, recurso y tenant.
2. Gates requeridos sobre el commit exacto y revisión independiente del PR abierto.
3. Verificación visual del HTML real a varios anchos, controles de teclado y ausencia de desbordamiento.
4. Integración y despliegue expresamente autorizados; reconexión del grant de Steven con permisos visibles y aprobación específica.
5. Llamada real desde el dot correcto, publicación aceptada, recibo durable y respuesta correlacionada de Jarvis. Una prueba local no satisface este criterio.

## Activación pendiente del integrador

El overlay `deploy/compose.mcp-human-local.yaml` configura explícitamente ocho horas por defecto. Para activar treinta días, el dueño debe configurar `CAUCE_MCP_OAUTH_GRANT_TTL_SECONDS=2592000` en el despliegue autorizado. La interfaz muestra el valor efectivo recibido del arranque, no una promesa fija de treinta días.

Los grants existentes conservan su vencimiento original. La recuperación sólo encuentra sucesores emitidos por el nuevo mecanismo; no reconstruye una rotación antigua aleatoria. Cambiar la clave de firma también cambia la derivación y exige tratar los reintentos pendientes como no recuperables.

Este trabajo no autoriza merge, despliegue, modificación de credenciales, red o permisos de producción. No garantiza conexión eterna: expiración, retirada del consentimiento, cambio de contraseña o pérdida de permisos requieren otra autorización.
