# @cauce/adapter-sdk

Conecta un agente CLI real a Cauce: consumidor durable + ejecución sobre la sesión del harness.

**Transporte:** un WS de larga vida contra el gateway con hello (tenant/alias/instance/capacidades); toda entrega se persiste localmente ANTES de ejecutarse; los ACKs (`accepted → started → done|failed`) se correlacionan por `event_id`+`delivery_id`+`attempt`+`claim_token` (nunca por orden FIFO); reconexión y reentrega reusan los mismos IDs — un duplicado del mismo intento jamás ejecuta dos veces.

**Ejecución:** entregar significa **pegar el texto en la sesión tmux viva** del harness (`paste-runner.ts`, `tmux.ts`: cuarentena de panel, barrera de input) y esperar el turno del modelo. Es la parte cara e inherentemente frágil del diseño: el error típico de producción es del turno del harness (timeouts de ACK, deadline excedido), no del bus.

**Ejecutables (`src/bin/`):** `openclaw`, `claude`, `codex` — los que usa la flota real. `hermes`, `opencode` y `fake` no tienen ningún usuario en producción (candidatos a `_legado`; `fake` lo usan los tests).

**Estado real a 2026-08-27:** 9 de 11 adaptadores de la flota corren el bundle del 14-ago; lo commiteado después no está desplegado (FASE 3).

**Probar:** `pnpm --filter @cauce/adapter-sdk test` (674 tests, node:test).
