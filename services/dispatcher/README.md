# @cauce/dispatcher

El segador del sistema — **no reparte mensajes**, pese al nombre.

**Hace:** en bucle, devuelve a `pending` las entregas cuyo claim venció (`retryStaleDeliveries`), reintenta jobs expirados, barre cadenas mudas y poda datos de observabilidad. Su único handler de job registrado es `system.database.probe` (y `qa.fairness` solo bajo `NODE_ENV=test`).

**No hace:** ejecutar agentes ni empujar entregas. Está escrito en `src/handlers.ts`: "Agent/model execution is intentionally absent: adapters, not the dispatcher, own that boundary."

**Tamaño real:** ~850 líneas en 6 ficheros — la pieza más pequeña y estable del núcleo.

**Correr en dev:** `pnpm dev:dispatcher`. **Probar:** `test/` del paquete.
