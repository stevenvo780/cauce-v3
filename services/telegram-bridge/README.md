# @cauce/telegram-bridge

El canal de entrada/salida más usado del sistema (en producción: ~12.000 mensajes entrantes por Telegram frente a 1 real de la consola).

**Entrada:** polling del Bot API con lease cercado por bot (`channel_bridge_leases`: owner + epoch; un poller viejo queda `fenced`) y cursor durable — nunca dos pollers vivos ni updates repetidos.

**Salida:** egress con efectos idempotentes (`telegram_egress_effects` registra cada chunk `sent|ambiguous`), allowlist de contactos y protección anti doble respuesta.

**Config:** directorio externo read-only con token y markers (ver `deploy/`); el bridge es un profile propio del compose. `operator_commands` es opt-in por alias (DM + `operator_user_ids`); ver `CONFIGURATION.md`.

**Correr en dev:** `pnpm dev:telegram-bridge`. **Probar:** `test/` del paquete.

## `media-group.ts` — notas de diseño

Prosa recortada de los comentarios de `media-group.ts` para respetar el tope de comentarios de
`scripts/calidad.mjs`; el comportamiento no cambió, sólo se movió el porqué.

### `AlbumKey` — la única regla de pertenencia de un álbum

Un álbum llega hasta 10 miembros y un lote guarda `MAX_MEDIA_GROUP_MEMBERS`, así que los miembros
5-N llegan como una continuación INMEDIATA cuyo `captionMember` recae en un miembro SIN pie de
foto: juzgado solo, no está dirigido a nadie y muere como `updates_unaddressed` — la pérdida que
este coalescedor existe para eliminar — movida más allá del límite del lote. Sólo esa continuación
inmediata está cubierta: se retiene un álbum, y cualquier update ajeno entre las dos mitades lo
limpia.

`media_group_id` NO es una autorización: llega en el mismo payload sin validar que todo lo demás,
así que nunca es evidencia sobre un vecino. Un miembro viaja bajo el marco del principal sólo si
coincide con esta clave — chat, usuario Y hilo — y su propia decisión de direccionamiento en vivo lo
admite o lo rechaza por `not_addressed`, el ÚNICO rechazo que significa "este miembro no escribió
nada propio" y el único que un miembro sin pie de foto no puede evitar. La política de hilo,
`sender_chat`, `via_bot`, `from.is_bot` y un pie de foto dirigido a otro alias de la flota juzgan
por tanto a CADA miembro sobre su propio mensaje: dentro del lote mediante `splitOwnMembers`, a
través del límite mediante `recall`, que responde ese mismo rechazo perdonable y nada más. Lo que la
regla rechaza se audita con su motivo real y se descarta, nunca se publica en un chat, tema o
sesión que nunca lo recibió.

### `albumMessage` — el pliegue de pies de foto

La Bot API admite un pie de foto por elemento del álbum, y antes sólo se publicaba el del
principal: los bytes de los demás miembros viajaban y las instrucciones escritas en ellos no, sin
registro de auditoría, sin métrica y sin forma de que la persona lo supiera — y sólo cuando el
álbum cabía en un mensaje, así que si una frase llegaba al agente dependía del presupuesto de bytes
agregado. Cada miembro aquí ya pasó la regla `AlbumKey`, así que lo que se pliega es el mismo chat,
el mismo usuario y el mismo tema; nada más se combina.

## `text-chunks.ts` — las piezas en que Telegram parte un texto largo

Un cliente de Telegram no envía un texto de más de 4096 caracteres: lo corta en mensajes
consecutivos de hasta 4096 y los manda uno detrás de otro. Cada pieza llegaba como un update propio y
se publicaba sola: el agente contestaba la primera y las demás quedaban como mensajes sueltos que
nadie leía entero. `CoalescingBuffer` reúne la cadena y el poller la publica como UN mensaje bajo el
`update_id` y el `message_id` de la primera pieza, con el texto concatenado tal cual (Telegram corta
sin añadir nada, así que se une sin separador) y las `entities` de las piezas siguientes desplazadas
por la longitud UTF-16 que las precede.

La regla de continuación es estrecha a propósito, porque el bus no puede inferir que dos mensajes
humanos son uno: la pieza anterior tiene al menos `TEXT_CHUNK_MIN_CHARACTERS` (4000: la longitud
de un corte, con margen para clientes que cortan antes), la siguiente es texto plano del mismo chat,
el mismo usuario y el mismo hilo, y sus `date` distan como mucho `TEXT_CHUNK_MAX_GAP_SECONDS` (5 s).
Un texto corto nunca se pega al anterior; un mensaje sin `date`, con medios, o de otro remitente
cierra la cadena; la cadena se cierra sola al llegar una pieza corta (la última de un corte casi
siempre lo es) o al alcanzar `MAX_TEXT_CHUNKS`.

El reloj es la parte delicada. `getUpdates` devuelve al instante cualquier update no confirmado, y la
primera pieza no se confirma hasta publicar la cadena: en el ciclo siguiente Telegram la reentrega
sola, casi siempre ANTES de que el cliente haya terminado de enviar la segunda. La regla de ciclo de
los álbumes (cerrar lo que no creció en este ciclo) habría publicado la primera pieza suelta, que es
justo el defecto. Una cadena de texto sólo se asienta `TEXT_CHUNK_SETTLE_MS` (2 s) después de su
ÚLTIMA pieza; `runOnce` devuelve sólo los updates nuevos, de modo que el bucle duerme `idleMs` entre
reentregas en vez de martillear la API mientras espera. El coste es que un mensaje suelto de 4000 a
4096 caracteres tarda esos 2 s en publicarse. `normalizedBody` admite la cadena reunida hasta
`MAX_CHAINED_TEXT_CHARACTERS`; todo lo demás sigue acotado a un mensaje de Telegram.
