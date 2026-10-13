# Meta: conexión OAuth renovable y autorización comprensible

## Resultado buscado

Cauce permite que el cliente renueve sus tokens de acceso sin pedir otro consentimiento durante la vigencia autorizada. La conexión de Steven debe volver a funcionar desde su dot y demostrar publicación durable y respuesta correlacionada de Jarvis. La pantalla de autorización debe resultar legible en escritorio y móvil y explicar destino, permisos, duración y revocación.

## Comportamiento preparado

- Tokens de acceso de hasta cinco minutos; autorizaciones nuevas de treinta días por defecto, con plazo configurable y fijo desde el consentimiento.
- Rotación del refresh token con un único sucesor durable. Durante los sesenta segundos de gracia existentes, un reintento devuelve ese sucesor si todavía no se ha consumido. Emite otro token de acceso corto tras revalidar toda la autoridad.
- Recuperación después de pérdida de respuesta y reinicio: el sucesor se deriva mediante HMAC con una clave derivada por HKDF-SHA256 de la clave de firma existente y separación por versión, issuer, recurso, grant y hash anterior. PostgreSQL conserva únicamente hashes. No hay nuevas claves persistentes ni caché como autoridad.
- Reutilización fuera de la gracia: revocación del grant completo. Dentro de la gracia, un sucesor ya consumido o inexistente se rechaza; no se avanza por cadenas de tokens antiguos.
- Cada renovación y recuperación verifica cuenta, sello de credencial, vínculo, membresía, tenant, alias, scopes, revocación y vencimiento. La renovación no extiende el grant.
- Compatibilidad con `ui_locales`, enviado por ChatGPT. La pantalla sigue en español; la preferencia no modifica la autoridad ni se inserta en el HTML.
- Pantallas de entrada, sesión, consentimiento y autorizaciones con CSS local permitido por nonce CSP; sin recursos externos, permisos premarcados ni cambios de CSRF.

## Derivación y transición de refresh tokens

La clave que genera el sucesor determinista se deriva del DER PKCS8 privado de P-256 mediante HKDF-SHA256, con sal vacía, info `cauce-oauth-refresh-successor-v1` y salida de 32 bytes. La ventana de recuperación continúa en 60 segundos. Al pasar del HMAC con DER directo a HKDF no se mantiene una ventana de compatibilidad con la clave antigua ni se intenta una derivación heredada: recuperar dentro de la gracia una respuesta emitida con el algoritmo anterior devuelve `invalid_grant` sin revocar el grant; un refresh heredado todavía vivo continúa válido y rota a un sucesor HKDF. Si el cliente perdió aquella respuesta y solo conserva el padre ya consumido, debe autorizar de nuevo.

**Revocación tardía en la transición:** un cliente que perdió la respuesta justo antes del despliegue recibe `invalid_grant` al reintentar el mismo padre dentro de la gracia. Si vuelve a enviarlo pasados los 60 segundos desde su consumo, se revoca la familia completa y tiene que volver a autorizar. El replay fuera de gracia conserva así la revocación previa.

**Fragilidad del material de entrada:** la derivación parte del PKCS8 que exporta OpenSSL mediante Node. Si cambia la serialización o la clave, cambia la derivación. Este fallo de recuperación se limita a los reintentos pendientes de la ventana de 60 segundos: se rechazan de forma segura con `invalid_grant` sin revocar el grant dentro de la gracia. Los reinicios con el mismo material exportado conservan el determinismo.

## Criterios de cierre

1. Pruebas con el SDK MCP real y PostgreSQL desechable: respuesta perdida después del commit, reinicio, concurrencia, replay, expiración, revocación y aislamiento de cliente, recurso y tenant.
2. Gates requeridos sobre el commit exacto y revisión independiente del PR abierto.
3. Verificación visual del HTML real a varios anchos, controles de teclado y ausencia de desbordamiento.
4. Integración y despliegue expresamente autorizados; reconexión del grant de Steven con permisos visibles y aprobación específica.
5. Llamada real desde el dot correcto, publicación aceptada, recibo durable y respuesta correlacionada de Jarvis. Una prueba local no satisface este criterio.

## Activación pendiente del integrador

Este cambio no modifica duración ni configuración: el valor predeterminado del código ya era treinta días y el overlay `deploy/compose.mcp-human-local.yaml` sigue en ocho horas; resolver esa discrepancia queda a decisión del dueño. Para activar treinta días, el dueño debe configurar `CAUCE_MCP_OAUTH_GRANT_TTL_SECONDS=2592000` en el despliegue autorizado. La interfaz muestra el valor efectivo recibido del arranque, no una promesa fija de treinta días.

La renovación no prolonga la expiración original del grant. PostgreSQL sigue conservando solo hashes y cada recuperación exige autoridad vigente y un sucesor sin consumir. La recuperación sólo encuentra sucesores emitidos por el nuevo mecanismo; no reconstruye una rotación antigua aleatoria ni un sucesor derivado del DER directo.

Este trabajo no autoriza merge, despliegue, modificación de credenciales, red o permisos de producción. No garantiza conexión eterna: expiración, retirada del consentimiento, cambio de contraseña o pérdida de permisos requieren otra autorización.
