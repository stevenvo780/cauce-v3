# Auditoría de "dientes" — `packages/{store,adapter-sdk,protocol,mcp-fleet-monitor}`

Sector completo: 96 ficheros `.test.ts` (39 `adapter-sdk/test/`, 4 `protocol/test/`, 50 `store/test/`, 2 `store/src/`, 1 `mcp-fleet-monitor/src/`). Recorrido de cada fichero: total **1 375 tests** (sub-tests de `it.each` expandidos; los `for`/`describe.each` anidados cuentan como una entrada por caso). Sólo **2 tests sin-dientes** en todo el sector, ambos `smoke-vacío`. Cero `it.skip` / `describe.skip` / `test.todo` / `xit` / guardas por `process.env`. Cero tautológicos.

## 1. Tabla por fichero

`C-dientes` = asserts sobre valor devuelto, estado de BD, error lanzado por código real, o llamada verificada a dependencia con argumentos significativos. `Sin-dientes` = subtipo descrito en columna derecha.

| fichero | tests | con-dientes | sin-dientes | skips | tautológicos | subtipo sin-dientes |
|---|---:|---:|---:|---:|---:|---|
| packages/adapter-sdk/test/account-credentials.test.ts | 12 | 12 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/artifact-inliner.test.ts | 19 | 19 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/bloque-gestionado.test.ts | 14 | 14 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/bridges.test.ts | 12 | 12 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/client.test.ts | 29 | 29 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/config.test.ts | 4 | 4 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/contexto-fijo-no-se-repite.test.ts | 8 | 8 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/dialects.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/durable-store.test.ts | 22 | 22 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/engine-session-queue.test.ts | 4 | 4 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/engine.test.ts | 68 | 68 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/fanin-synthesizer.test.ts | 10 | 10 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/fence.test.ts | 9 | 9 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/gate-probe.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/harness-turn-failure.test.ts | 14 | 14 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/harnesses.test.ts | 40 | 40 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/identity-preamble.test.ts | 5 | 5 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/manifests.test.ts | 3 | 3 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/observability.test.ts | 4 | 2 | 2 | 0 | 0 | smoke-vacío |
| packages/adapter-sdk/test/openclaw-terminal-pointer.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/openclaw.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/output-parser-contract.test.ts | 38 | 38 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/output-parser-lost-delegations.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/output-parser-sobre-roto.test.ts | 30 | 30 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/perfil-a-contexto.test.ts | 28 | 28 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/pingpong-descarte.test.ts | 6 | 6 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/preflight-retry.test.ts | 14 | 14 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/presupuesto-del-sobre.test.ts | 4 | 4 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/process-runner-orphan-pipes.test.ts | 4 | 4 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/process-runner.test.ts | 5 | 5 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/protocol-prompt.test.ts | 16 | 16 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/runtime-capabilities.test.ts | 6 | 6 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/sello-desde-el-adaptador.test.ts | 8 | 8 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/session-origin.test.ts | 4 | 4 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/shared-session-turn-merge.test.ts | 10 | 10 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/shared-session.test.ts | 115 | 115 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/siembra-del-contexto.test.ts | 8 | 8 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/siembra-del-perfil.test.ts | 21 | 21 | 0 | 0 | 0 | — |
| packages/adapter-sdk/test/websocket-transport.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/protocol/test/ficheros-del-arnes.test.ts | 20 | 20 | 0 | 0 | 0 | — |
| packages/protocol/test/ficheros-que-no-mienten.test.ts | 18 | 18 | 0 | 0 | 0 | — |
| packages/protocol/test/priority.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/protocol/test/schemas.test.ts | 24 | 24 | 0 | 0 | 0 | — |
| packages/store/src/fleet-activity.test.ts | 9 | 9 | 0 | 0 | 0 | — |
| packages/store/src/repository.quota-schema-version.test.ts | 3 | 3 | 0 | 0 | 0 | — |
| packages/store/test/abortable-transaction-postgres.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/store/test/agent-chain-visibility-postgres.test.ts | 20 | 20 | 0 | 0 | 0 | — |
| packages/store/test/agent-output-postgres.test.ts | 45 | 45 | 0 | 0 | 0 | — |
| packages/store/test/agent-profile-migration-postgres.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/store/test/agent-profile-mutacion.test.ts | 5 | 5 | 0 | 0 | 0 | — |
| packages/store/test/agent-profile-postgres.test.ts | 42 | 42 | 0 | 0 | 0 | — |
| packages/store/test/agent-profile-presence.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/store/test/agent-profile-runtime-adoption-migration-postgres.test.ts | 4 | 4 | 0 | 0 | 0 | — |
| packages/store/test/agent-profile-runtime-adoption-postgres.test.ts | 5 | 5 | 0 | 0 | 0 | — |
| packages/store/test/agent-target-access.test.ts | 4 | 4 | 0 | 0 | 0 | — |
| packages/store/test/ambiguous-without-execution-postgres.test.ts | 4 | 4 | 0 | 0 | 0 | — |
| packages/store/test/audit-pagination-postgres.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/store/test/audit-summary.test.ts | 6 | 6 | 0 | 0 | 0 | — |
| packages/store/test/canonical-agent-role-postgres.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/store/test/catalogo-no-se-filtra.test.ts | 5 | 5 | 0 | 0 | 0 | — |
| packages/store/test/chain-silence-sweep-postgres.test.ts | 17 | 17 | 0 | 0 | 0 | — |
| packages/store/test/configuration-reader.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/store/test/connection-session-fencing-migration-postgres.test.ts | 3 | 3 | 0 | 0 | 0 | — |
| packages/store/test/connection-session-fencing-postgres.test.ts | 3 | 3 | 0 | 0 | 0 | — |
| packages/store/test/console-publish-intent-migration-postgres.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/store/test/console-publish-intent-postgres.test.ts | 24 | 24 | 0 | 0 | 0 | — |
| packages/store/test/delegation-discipline-postgres.test.ts | 16 | 16 | 0 | 0 | 0 | — |
| packages/store/test/delegation-guard.test.ts | 13 | 13 | 0 | 0 | 0 | — |
| packages/store/test/delivery-admission-postgres.test.ts | 16 | 16 | 0 | 0 | 0 | — |
| packages/store/test/delivery-concurrency-postgres.test.ts | 14 | 14 | 0 | 0 | 0 | — |
| packages/store/test/dlq-causal-reconciliation-migration-postgres.test.ts | 6 | 6 | 0 | 0 | 0 | — |
| packages/store/test/dlq-causal-reconciliation-postgres.test.ts | 16 | 16 | 0 | 0 | 0 | — |
| packages/store/test/egress-notification-postgres.test.ts | 32 | 32 | 0 | 0 | 0 | — |
| packages/store/test/failure-notice-coalescing-postgres.test.ts | 12 | 12 | 0 | 0 | 0 | — |
| packages/store/test/fleet-reconciliation-postgres.test.ts | 6 | 6 | 0 | 0 | 0 | — |
| packages/store/test/late-terminal-ack-postgres.test.ts | 18 | 18 | 0 | 0 | 0 | — |
| packages/store/test/lease-cap-postgres.test.ts | 8 | 8 | 0 | 0 | 0 | — |
| packages/store/test/legacy-console-outbox-reconciliation-postgres.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/store/test/materialization-crosstenantroom-postgres.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/store/test/migration-integrity-postgres.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/store/test/muestra-no-es-total.test.ts | 3 | 3 | 0 | 0 | 0 | — |
| packages/store/test/observability-retention-postgres.test.ts | 8 | 8 | 0 | 0 | 0 | — |
| packages/store/test/priority-band-postgres.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/store/test/publish-receipt-postgres.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/store/test/queue-heartbeat-postgres.test.ts | 3 | 3 | 0 | 0 | 0 | — |
| packages/store/test/replay-postgres.test.ts | 5 | 5 | 0 | 0 | 0 | — |
| packages/store/test/retry-policy-postgres.test.ts | 10 | 10 | 0 | 0 | 0 | — |
| packages/store/test/sql-locking-clauses.test.ts | 2 | 2 | 0 | 0 | 0 | — |
| packages/store/test/terminal-browser-owner-fencing-migration-postgres.test.ts | 4 | 4 | 0 | 0 | 0 | — |
| packages/store/test/terminal-recovery-postgres.test.ts | 10 | 10 | 0 | 0 | 0 | — |
| packages/store/test/terminal-relay-instance-fencing-migration-postgres.test.ts | 5 | 5 | 0 | 0 | 0 | — |
| packages/store/test/terminal-session-claim-fencing-migration-postgres.test.ts | 9 | 9 | 0 | 0 | 0 | — |
| packages/store/test/timeout-retry-backoff.test.ts | 5 | 5 | 0 | 0 | 0 | — |
| packages/store/test/topology-registry-postgres.test.ts | 1 | 1 | 0 | 0 | 0 | — |
| packages/store/test/visited-path-fallback-postgres.test.ts | 7 | 7 | 0 | 0 | 0 | — |
| packages/mcp-fleet-monitor/src/fleet-read-model.test.ts | 9 | 9 | 0 | 0 | 0 | — |
| **TOTAL** | **1 375** | **1 373** | **2** | **0** | **0** | — |

## 2. Peores de mi lote

Sólo dos tests sin-dientes en todo el sector, ambos `smoke-vacío` y los dos en el mismo fichero. Cero skips, cero tautológicos. El ranking de "peores" no tiene suficiente material para discriminar: los 12 siguientes son los ficheros con peor balance según lo único que se puede medir con estos datos — densidad de asserts cuyo único efecto es no fallar.

1. `packages/adapter-sdk/test/observability.test.ts:247` — test "logger is optional (graceful degradation)" — subtipo **smoke-vacío**. Aserción única:
   ```
   packages/adapter-sdk/test/observability.test.ts:273:        assert(true, "engine should handle missing logger gracefully");
   ```
   Cita textual:
   ```ts
   // Should complete without errors
   assert(true, "engine should handle missing logger gracefully");
   ```

2. `packages/adapter-sdk/test/observability.test.ts:276` — test "error messages include sanitized stderr detail" — subtipo **smoke-vacío**. Aserción:
   ```
   packages/adapter-sdk/test/observability.test.ts:310:        assert(true, "error should be logged when harness fails");
   ```
   Cita textual:
   ```ts
   // Verify error was logged (even if it might be async)
   // The actual error capture happens in harnesses/shared.ts during parse
   assert(true, "error should be logged when harness fails");
   ```

3-12. Siguientes candidatos, ordenados por menor densidad / más "smoke" en la composición. Todos con 0 sin-dientes, pero la mayoría de sus asserts son `assert.equal(x, k)` sobre valores fijos producidos por su propio fixture (caso que en otra auditoría se etiquetaría como "prueba-al-mock" si las expectativas se copiaran del mock; aquí los valores vienen de funciones reales, así que los marco como (a) por la regla del usuario, pero los listo para que conste):

   - `packages/store/test/topology-registry-postgres.test.ts` — 1 test, asserts sobre una sola instantánea de la BD semilla; cobertura muy estrecha.
   - `packages/store/test/configuration-reader.test.ts` — 2 tests, mock-pool de un solo cliente SQL.
   - `packages/store/test/agent-profile-presence.test.ts` — 2 tests, mock-pool de un solo cliente SQL.
   - `packages/store/test/agent-target-access.test.ts` — 4 tests, mock-pool.
   - `packages/store/test/legacy-console-outbox-reconciliation-postgres.test.ts` — 2 tests reales pero sin sub-casos del error path.
   - `packages/store/test/publish-receipt-postgres.test.ts` — 2 tests, pero la salida del `expect.toThrow` se cubre.
   - `packages/store/test/materialization-crosstenantroom-postgres.test.ts` — 2 tests grandes con asserts de base después de un fixture complejo; cobertura ajustada al incidente.
   - `packages/store/test/migration-integrity-postgres.test.ts` — 2 tests, pero cada uno de ellos es una migración real rodada contra un Postgres de verdad.
   - `packages/store/test/connection-session-fencing-migration-postgres.test.ts` — 3 tests de migración.
   - `packages/store/test/connection-session-fencing-postgres.test.ts` — 3 tests de fencing de sesión.
   - `packages/store/test/agent-profile-mutacion.test.ts` — 5 tests, mock-pool con `fakePool` de 4 respuestas programadas.

3. Sección "Skips"

`grep` exhaustivo sobre los cuatro directorios del sector no encuentra `it.skip`, `test.skip`, `describe.skip`, `xit`, `xdescribe`, `test.todo` ni `it.todo` en ningún fichero de tests. Cero guardas `if (!process.env.X) return` o equivalentes. Nada que reportar.

## Observación de fondo

El sector está abrumadoramente con-dientes: 1 373 / 1 375 (99,85 %). Los dos tests sin-dientes están concentrados en un único fichero (`observability.test.ts`) y son del subtipo más leve: un `assert(true, "…")` que nunca falla. La mayoría de los tests ejercitan código real (mocks de BD, Postgres de verdad, child processes, WebSockets, harness runners) y verifican el efecto sobre el estado o la salida. La auditoría no encuentra skips, ni tautológicos, ni `prueba-al-mock`.

Ruta del fichero del reporte: `/datos/workspaces/zeus/cauce-v3/ordenes/reportes/_parcial-dientes-packages.md`
