# @cauce/telegram-bridge

El canal de entrada/salida más usado del sistema (en producción: ~12.000 mensajes entrantes por Telegram frente a 1 real de la consola).

**Entrada:** polling del Bot API con lease cercado por bot (`channel_bridge_leases`: owner + epoch; un poller viejo queda `fenced`) y cursor durable — nunca dos pollers vivos ni updates repetidos.

**Salida:** egress con efectos idempotentes (`telegram_egress_effects` registra cada chunk `sent|ambiguous`), allowlist de contactos y protección anti doble respuesta.

**Config:** directorio externo read-only con token y markers (ver `deploy/`); el bridge es un profile propio del compose.

**Correr en dev:** `pnpm dev:telegram-bridge`. **Probar:** `test/` del paquete.
