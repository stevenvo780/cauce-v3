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

## Trabajo pendiente para perfiles, cuentas y representación

- La tabla de usuarios ya admite cuentas separadas; esta corrección distingue su
  autoría aunque compartan alias técnico. No crea cuentas ni cambia permisos
- Faltan una experiencia de perfiles/cambio de cuenta y una política explícita de
  pertenencia y permisos por sujeto humano antes de tratarla como aislamiento
  completo entre cuentas que hoy comparten el mismo alias
- Hablar en nombre de otro actor requiere un contrato propio: selección limitada
  a delegaciones vigentes autorizadas por servidor, tenant derivado de la sesión,
  comprobación de alcance en prepare y publish y registro tanto del sujeto humano
  real como del actor representado y del permiso usado
- Cambiar el nombre visible nunca debe cambiar autoría histórica, otorgar
  permisos ni hacerse pasar por una respuesta generada por un agente
- La atribución en los consumidores del bus y el protocolo de delegación quedan
  fuera de esta corrección de la consola; no se ofrece un selector sin autoridad
