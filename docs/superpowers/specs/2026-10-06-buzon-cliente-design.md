# Buzón durable del cliente MCP

Steven autorizó construir y desplegar la recepción bidireccional de Cronos. Jarvis debe poder iniciar mensajes hacia su conexión y Cronos consultarlos autenticado. ChatGPT sigue decidiendo cuándo ejecutar un turno; guardar un mensaje no lo despierta.

## Identidad y ruta

Una declaración activa de cliente habilita un buzón por grant OAuth local. Su dirección `mbx-<hash de tenant y grant>` es pública y no es una credencial. La etiqueta Cronos se muestra junto a ella. Renovar tokens o renombrar conserva la dirección. Un consentimiento nuevo crea otro buzón; no se trasladan mensajes por coincidencia de nombres o client_id.

El buzón no crea agente, membership, lease ni consumidor. Sólo adapters que anuncian `client_mailbox_v1` reciben sus destinos, con `online:false` y disponibilidad explícita del buzón. Los broadcasts a agentes no incluyen buzones.

## Persistencia y entrega

Se reutilizan messages, deliveries, idempotency_keys y agent_output_materializations. Una entrega al buzón termina el transporte con estado done, intento cero y result de clase client_mailbox/state stored, sin consumer ni delivery_ack. No se publica wake ni se retienen slots de ejecución. Ese estado acredita exclusivamente almacenamiento y se representa como «Guardado en buzón» en consola y MCP.

La resolución revalida grant, declaración, dueño, membresía, tenant, permisos y revocación dentro de la transacción. El remitente conserva las ACL de ruta existentes; no se introducen filtros temáticos. Se limita cada mensaje a 16 KiB de texto, sin adjuntos en esta versión, y cada grant a 1000 mensajes guardados. Un buzón lleno rechaza el efecto. No se elimina historia ni se cambia la retención global.

## Lectura

`cauce_mailbox` resuelve el grant desde la autoridad autenticada, nunca desde argumentos. Devuelve dirección, etiqueta, mensajes y cursor ligado a humano, tenant y grant. Se devuelve el texto completo, con páginas acotadas por bytes y los mensajes más recientes primero. Leer es sólo lectura. No acredita consumo, respuesta ni autorización para otra acción. `cauce_inbox` incluye una primera página para clientes con catálogo anterior.

Una revocación, expiración o desactivación corta la lectura y nuevos envíos. Un cambio de contraseña corta la lectura al revalidar credential_stamp; la admisión del envío comprueba la vigencia durable del grant y no la contraseña del dueño. Los mensajes almacenados siguen preservados.

## Verificación

Pruebas PostgreSQL de publicación, reintentos, aislamiento por grant y humano, renovación/rename/revoke, paginación con microsegundos, ausencia de ACK/lease/wake y liberación de slots. Pruebas SDK de destinos disponibles sin presencia y exclusión de broadcast; pruebas UI de almacenamiento sin ejecución. Revisión independiente, gates del commit exacto y despliegue con rollback. Cierre real: Jarvis inicia un mensaje nuevo hacia Cronos, se consulta aquí y Cronos envía la respuesta.
