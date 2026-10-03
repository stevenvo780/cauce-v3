# Identidad humana en los mensajes de consola

## Defecto y corrección acotada

La sesión por contraseña conoce la cuenta humana y su nombre de perfil, pero la
publicación histórica sólo guardaba el alias técnico usado por las membresías y
ACL. Por eso un mensaje escrito en consola podía verse como `kant → jarvis`.
No es suficiente sustituir todos los rótulos de Kant por el nombre del operador.

Las nuevas publicaciones de consola guardan la autoría humana autenticada en
`audit_events`, dentro del evento `message.publish` que se confirma en la misma
transacción que el mensaje, las entregas y el recibo. Se conservan:

- Identificador opaco del sujeto humano, separado por tenant y derivado del
  identificador estable del perfil autenticado; el correo no es el rótulo
- Nombre de perfil existente, como instantánea; sin nombre disponible se muestra
  «Persona autenticada», sin inferir nombre, propiedad ni rol de dueño
- Identidad técnica en las columnas existentes de tenant y actor del evento,
  vinculada al mismo mensaje, request y trace

El gateway obtiene estos datos de la sesión validada en servidor y los entrega
al store mediante opciones internas. El cuerpo público no acepta elegir actor,
tenant ni autor. Los metadatos del texto o del origen no establecen autoría.
El alias técnico sigue siendo autoridad de enrutamiento y ACL, no una afirmación
sobre quién escribió el texto.

## Lectura, reintentos y límites

Las consultas conservan los filtros de visibilidad existentes. Sólo proyectan
un autor si hay exactamente un evento permitido con coincidencia de mensaje,
request, trace, tenant y alias. Datos ausentes, ambiguos o inválidos quedan sin
autor humano probado. El índice de trace limita la búsqueda del evento.
La retención de observabilidad no elimina `message.publish`.

Un reintento idempotente devuelve el efecto original y no crea ni modifica su
instantánea de autor. El scope del operador, prepare, confirm, hashes del recibo,
estados de entrega, ACK y prioridad mantienen sus contratos. No se añade un
origen de transporte a la sesión web ni se inventa una ruta de respuesta.

La consola usa esta proyección para el rótulo humano y para distinguir un mensaje
humano dirigido al mismo alias técnico de una salida del agente. El alias sigue
disponible como identidad técnica. El historial previo no se reescribe: la
captura original por sí sola no demuestra qué persona escribió cada fila.

## Cuentas humanas y alcance del candidato

`console_users` ya admite personas con identificadores, nombres, contraseñas
derivadas y roles propios. El proveedor por contraseña relee la cuenta activa
en cada petición y deriva de ella la identidad humana y el tenant/alias técnico.
El alta y mantenimiento existentes corresponden al dueño; esta fase no crea
cuentas, credenciales, membresías ni permisos y no añade otro proveedor.

El candidato implementa **Cuenta** con el nombre humano y el detalle técnico,
y **Cambiar cuenta** mediante los endpoints de cierre e inicio existentes.
El cierre se confirma antes de reabrir la aplicación privada. Un cambio de
sesión descarta borradores, permisos y respuestas pendientes de la cuenta
anterior. Esto describe el código candidato; no acredita su publicación ni
despliegue. El proveedor externo puede volver a elegir la misma cuenta.

Dos personas con el mismo tenant/alias tienen autorías y scopes de intención
distintos, pero comparten el ámbito técnico de lectura y autorización existente.
Esto puede representar colaboración deliberada: el perfil humano no introduce
por sí solo privacidad entre esas personas. Los filtros actuales siguen
aplicándose por tenant, alias, participación y ACL.

La regresión `tests/unit/gateway-human-accounts.test.ts` enlaza dos logins del
proveedor real con sesión, acceso, prepare, publicación y confirmación del
gateway. Comprueba nombre/sujeto humano, cambio de sesión, relectura del perfil,
rol por cuenta, separación de actores de servicio y filtros técnicos. Usa sólo
usuarios y repositorio en memoria con `app.inject`; no prueba PostgreSQL,
aprovisionamiento real, navegador ni aislamiento durable nuevo. Las regresiones
de `AuthGate.account-lifecycle.test.tsx`, `auth-session.test.ts` y
`client.auth-race.test.ts` cubren por separado borradores y respuestas pendientes.

## Decisiones pendientes para representación y privacidad

- Si se necesita privacidad entre personas que comparten tenant/alias, el dueño
  debe decidir qué se comparte y qué es privado antes de definir pertenencia,
  permisos o almacenamiento por sujeto humano. No se cambia esa frontera aquí
- Hablar en nombre de otro actor requiere un contrato propio: selección limitada
  a delegaciones vigentes autorizadas por servidor, tenant derivado de la sesión,
  comprobación de alcance en prepare y publish y registro tanto del sujeto humano
  real como del actor representado y del permiso usado
- Cambiar el nombre visible nunca debe cambiar autoría histórica, otorgar
  permisos ni hacerse pasar por una respuesta generada por un agente
- La atribución en los consumidores del bus y el protocolo de delegación quedan
  fuera de esta corrección de la consola; no se ofrece un selector sin autoridad

## Editar el nombre propio

Con una sesión humana de contraseña, **Cuenta → Editar nombre → Guardar nombre**
actualiza el nombre en el servidor. Se recortan los espacios exteriores y se aceptan
entre 1 y 120 caracteres Unicode. La respuesta confirmada actualiza Cuenta sin cerrar
la sesión ni descartar el borrador de mensaje. Si falla, la edición queda disponible
para reintentar; Cancelar, Escape, cerrar Cuenta o navegar descartan la edición no guardada.
Una operación ya enviada puede terminar aunque se cierre el editor.

`PATCH /v3/auth/profile` recibe exclusivamente `{ "name": "Nombre" }` y devuelve
únicamente el nombre persistido. Exige sesión humana password, CSRF y origen permitido.
El servidor elige la fila autenticada: sólo modifica `display_name` y `updated_at`.
También un lector puede cambiar su propio nombre, sin recibir capacidades operativas.
No es una administración de personas ni permite cambiar correo, contraseña, rol,
tenant, alias o estado. Las altas y bajas siguen bajo mantenimiento del dueño.

Las sesiones externas y de servicio no ofrecen este editor. Los mensajes nuevos leen
el nombre confirmado de la cuenta; los anteriores mantienen su instantánea y el sujeto
humano estable. Las pruebas sintéticas de este flujo no acreditan PostgreSQL real,
cuentas provisionadas ni despliegue; esos gates siguen siendo necesarios antes de integrar.
