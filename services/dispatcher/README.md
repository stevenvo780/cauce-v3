# @cauce/dispatcher

El segador del sistema — **no reparte mensajes**, pese al nombre.

**Hace:** en bucle, devuelve a `pending` las entregas cuyo claim venció (`retryStaleDeliveries`), reintenta jobs expirados, barre cadenas mudas y poda datos de observabilidad. Su único handler de job registrado es `system.database.probe` (y `qa.fairness` solo bajo `NODE_ENV=test`).

**No hace:** ejecutar agentes ni empujar entregas. Está escrito en `src/handlers.ts`: "Agent/model execution is intentionally absent: adapters, not the dispatcher, own that boundary."

**Aislamiento por fase:** cada fase del tick (`stale_deliveries`, `expired_jobs`, `chain_sweep`, `claim_jobs`, `retention`) corre en su propio `try/catch` dentro de `src/phases.ts`. Una fila envenenada —una entrega cross-tenant que viola el FK, o un SQL inválido— ya no tumba el tick entero: la fase que revienta suma en `cauce_dispatcher_phase_failures_total{phase}` y queda en espera exponencial (base = el intervalo del tick, tope 5 min) mientras las demás siguen trabajando; `chain_sweep` y `retention` conservan además su propia cadencia y no consumen su ventana cuando están en espera. El tick sigue contando como fallido, y por tanto `ready` sigue en rojo, mientras una de las tres fases del núcleo esté rota o esperando su backoff: la degradación no se esconde detrás de un tick verde.

**Tamaño real:** ~900 líneas en 7 ficheros — la pieza más pequeña y estable del núcleo.

**Correr en dev:** `pnpm dev:dispatcher`. **Probar:** `test/` del paquete.
