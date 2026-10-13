# @cauce/dispatcher

El segador del sistema — **no reparte mensajes**, pese al nombre.

**Hace:** en bucle, devuelve a `pending` las entregas cuyo claim venció (`retryStaleDeliveries`), reintenta jobs expirados, barre cadenas mudas y poda datos de observabilidad. Su único handler de job registrado es `system.database.probe` (y `qa.fairness` solo bajo `NODE_ENV=test`).

**No hace:** ejecutar agentes ni empujar entregas. Está escrito en `src/handlers.ts`: "Agent/model execution is intentionally absent: adapters, not the dispatcher, own that boundary."

**Aislamiento por fase:** `PhaseGuard.run` (`src/phases.ts`) aísla cada llamada de fase. `stale_deliveries`, `expired_jobs`, `chain_sweep`, el `claimFairJobs` de `claim_jobs` y `retention` van cada uno en su `guard.run`. Una fila envenenada en esas llamadas —una entrega cross-tenant que viola el FK, o un SQL inválido— no tumba el tick: la fase suma en `cauce_dispatcher_phase_failures_total{phase}` y queda en espera exponencial (base = el intervalo del tick, tope 5 min) mientras las demás siguen. El procesamiento de los jobs ya reclamados (`runClaimedJobs` en `src/index.ts`) queda fuera de `guard.run`. Un fallo de `asClaimedJob`, de `deadLetterUnknownJob` o de `repository.failJob` sale del tick, hace `recordTick('error')` y se relanza, sin incrementar `phase_failures` de `claim_jobs`. El error de un handler sí queda dentro del `try` de ese job. `chain_sweep` no consume su ventana si el guard devuelve `skipped`: `lastChainSweep` solo avanza cuando el estado no es `skipped`. `retention` avanza `nextPruneAtMs` antes de `guard.run`; si la fase está en backoff, la ventana ya se consumió. Lo mismo hace la poda de adjuntos con `nextAttachmentPruneAtMs` cuando le toca correr. El tick cuenta como fallido, y `ready` sigue en rojo, mientras `stale_deliveries`, `expired_jobs` o el `claimFairJobs` de `claim_jobs` no estén en `ok`.

**Tamaño real:** ~900 líneas en 7 ficheros — la pieza más pequeña y estable del núcleo.

**Correr en dev:** `pnpm dev:dispatcher`. **Probar:** `test/` del paquete.
