# Plan de implementación

## Base y alcance

Incremento sobre dev `3eccb57569db1858a5c3159f76551c26452ea2e5`, árbol
`d1262babe2c1c75c826db5f5ae52c042a0dbb301`, con PR11 integrado. Se preservan
los 2196 blobs verificados y las preimágenes de las rutas modificadas. Se compone primero la corrección independiente de 404 ambiguo, árbol
`c38f13f1776a2e9b7ab2082c54e172f437fc36e9` (dos rutas); la aplicación se entrega
como segundo parche sobre ese árbol. No se modifica el incremento de lectura congelado ni se crea otra autoridad de escritura.

## Flujo

1. Inspección Git existente, siempre de lectura y con ámbito del servidor
2. POST `/context/repository/preview` exige control, persona atribuida y motivo
3. Inspector de OID completo, procedencia del diario y perfil actual existente
4. Preflight nativo y confirmación ligada a instancia, actor, persona, motivo,
   origen, revisión, diario vigente y huellas; sin alegar limpieza del checkout
5. PUT `/perfil` canónico con confirmación opcional para esta operación
6. Nueva autorización, nueva medición, igualdad exacta e intención auditada
7. CAS existente reforzado bajo bloqueo de agente/perfil con identidad de diario
8. Procedencia y recibo en la auditoría de la misma transacción; sin migración
9. Saga nativa y adopción existentes; repetir recibo no vuelve a escribir runtime

Un perfil idéntico al vigente devuelve `profile_already_current`, sin revisión
artificial. Una recuperación nativa pendiente utiliza los controles existentes
de recarga/reconciliación y exige su propia autorización. El recibo de Git sólo
acredita que existió una operación durable, incluso si el alias fue recreado después.
Nunca presenta esa evidencia histórica como adopción del alias actual.

## Fronteras

No importación arbitraria ni contenido nuevo sólo en Git; el origen debe coincidir
con ID, revisión, operación y siete campos del diario. No aplica a perfil ausente.
MEMORY/HEARTBEAT deben existir y conservar SHA/tamaño; se rechaza su siembra.
El servidor no recibe rutas del navegador. Sin instalaciones, remotos, clones,
configuración productiva, despliegue ni aplicación real durante esta entrega.
Restauraciones de BD requieren revalidar la identidad de instancia por el dueño.
La retención de auditoría puede retirar recibos; no relaja el CAS de diario vigente.

## Pruebas

Objetos Git sueltos sintéticos, Fastify.inject, dependencias en memoria y modelo
sintético de bloqueo prueban validación, autorización, CAS, repetición y estados.
No sustituyen PostgreSQL real, adopción de un arnés vivo ni navegador autenticado.
Pruebas UI: vista previa, confirmación, cancelación, respuestas tardías, bloqueo,
refresco, permiso revocado, doble clic y recibos no acreditados. Ningún reintento
automático tras incertidumbre. Revisión independiente antes de publicación.
