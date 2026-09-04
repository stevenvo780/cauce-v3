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
