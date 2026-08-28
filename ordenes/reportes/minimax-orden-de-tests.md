# Orden de tests — censo maestro + plan de partición + convención (2026-08-28)

> Solo lectura. Insumo de la Tarea 2 (partición byte-pura de los 3 gigantes de `adapter-sdk`) y de la decisión del dueño sobre la convención única. Cruce con `minimax-cobertura-gate.md` (qué gate ejecuta cada fichero) y `minimax-dientes.md` (calidad de los tests).

**Método**: 4 subagentes en paralelo (ficheros DISJUNTOS) han censado zonas separadas:

| Subagente | Zona censada | Ficheros |
|---|---|---|
| 1 | `packages/adapter-sdk/test/**` | 40 |
| 2 | `services/**/src/` + `services/**/test/` + `console/src/` | 130 |
| 3 | `packages/{store,protocol,mcp-fleet-monitor}` + `tests/**` | 133 |
| 4 | `ops/tests/**` + `ops/pty-agent/tests/**` + `ops/scripts/*.test.sh` | 47 |

Total: **350 ficheros `.test.*`** + **~3.015 declaraciones `it()/test()`/`def test_`/`assert.*`**.

## Veredicto en una línea

El árbol tiene **15 ficheros >800 líneas** (todos ya en `scripts/calidad-base.json`); **12 son tests del propio repo**. La convención de ubicación es hoy una **matriz mixta con 5 reglas implícitas** que el dueño quiere unificar; recomiendo la opción C (ver §4) por mínimo coste y máximo respeto al riesgo. Los **3 gigantes que la orden me autoriza a partir** (`engine.test.ts`, `client.test.ts`, `durable-store.test.ts`) tienen plan byte-puro detallado abajo (§2); `shared-session.test.ts` (5.444 L, NO TOCAR) tiene mapa completo para que Codex lo ejecute después (§3).

## Totales por zona

| Zona | Ficheros | Líneas | # tests/it/def_test | % total tests | Runner | Convención actual |
|---|---:|---:|---:|---|---|---|
| `packages/adapter-sdk/test/` | 40 | 19 856 | 610 | 20,2 % | `vitest --test --test-concurrency=1 dist/test/*.test.js` (PLANO) | `test/` hermana |
| `packages/protocol/test/` | 4 | 1 137 | 63 | 2,1 % | `vitest run … packages/protocol/test` (test:unit) | `test/` hermana |
| `packages/store/src/` (mezcla) | 2 | 163 | 12 | 0,4 % | `vitest run packages/store/src` (test:unit) | **junto-al-fuente (excepción)** |
| `packages/store/test/` | 50 | 18 995 | 425 | 14,1 % | `./scripts/test.sh tests/store-hardening packages/store/test` | `test/` hermana |
| `packages/mcp-fleet-monitor/src/` | 1 | 171 | 9 | 0,3 % | `vitest run` (test:unit) | junto-al-fuente |
| `services/gateway/src/` | 30 | ~14 760 | 388 | 12,9 % | `vitest run src` | junto-al-fuente |
| `services/terminal-relay/src/` | 14 | ~4 325 | 167 | 5,5 % | `vitest run src/*.test.ts` | junto-al-fuente |
| `services/dispatcher/test/` | 3 | 320 | 17 | 0,6 % | `vitest run test/*.test.ts` | `test/` hermana |
| `services/telegram-bridge/test/` | 19 | ~5 122 | 246 | 8,2 % | `../../scripts/test.sh test/*.test.ts` | `test/` hermana |
| `console/src/` | 64 | ~12 740 | 616 | 20,4 % | `vitest run` (test:unit) | junto-al-fuente |
| `tests/unit/` | 39 | 4 666 | 194 | 6,4 % | `vitest run tests/unit` | matriz CI raíz |
| `tests/gateway-hardening/` | 17 | 7 632 | 108 | 3,6 % | `vitest run tests/gateway-hardening --testTimeout=120000` | matriz CI raíz |
| `tests/store-hardening/` | 9 | 3 727 | 95 | 3,2 % | `./scripts/test.sh tests/store-hardening … --testTimeout=180000` | matriz CI raíz |
| `tests/terminal-pty/` | 5 | 1 688 | 43 | 1,4 % | `vitest run tests/terminal-pty` | matriz CI raíz |
| `tests/integration/` | 4 | 1 282 | 27 | 0,9 % | `./scripts/test.sh tests/integration --testTimeout=120000` | matriz CI raíz |
| `tests/e2e/` | 2 | 765 | 13 | 0,4 % | `./scripts/test.sh tests/e2e --testTimeout=180000` | matriz CI raíz |
| `ops/tests/*.test.mjs` | 10 | 4 038 | 0 (`test()` plano) + 209 bare assert | — | `validate.sh` (6 ejec.) + 4 huérfanos | plana operativa |
| `ops/tests/test_*.py` | 9 | 1 707 | 73 | — | `validate.sh` (2 ejec.) + 7 huérfanos | plana operativa |
| `ops/pty-agent/tests/test_*.py` | 19 | ~5 019 | 218 | — | `python3 -m unittest discover -s ops/pty-agent` (test:pty) | `test/` hermana |
| `ops/scripts/fault-compose.test.sh` | 1 | 74 | 0 (bash) | — | **HUÉRFANO** | plana operativa |

**Gran total**: **350 ficheros, ~108 213 líneas, ~3 015 tests declarados.** **15 gigantes** (>800 L) — 12 tests + 3 productivos (`ops/cli/cauce`, `cauce-container-runtime.py`, `cauce-v3-medico-monitor`). Cobertura de gate actual: `vitest_unit` 195, `vitest_services` 66, `vitest_store_hardening` 58, `vitest_gateway_hardening` 18, `vitest_integration` 4, `vitest_e2e` 2, `vitest_terminal_pty` 5, `ops_ops_tests` 10 — total 358 (con solapes por workspaces).

## §1 — Convenciones detectadas (la matriz mixta actual)

| Convención | Workspaces que la cumplen | # tests | Coste si se cambia |
|---|---|---:|---:|
| **junto-al-fuente** (`src/*.test.ts`) | `console/`, `gateway/`, `terminal-relay/`, `mcp-fleet-monitor/`, `store/src/` (excepción de 2 ficheros) | ~1 192 | mover 16+15+15+3+2 = **51 ficheros** |
| **`test/` hermana** (`test/*.test.ts`) | `adapter-sdk/`, `protocol/`, `dispatcher/`, `telegram-bridge/`, `store/test/` (40+4+3+19+39 = 105) | ~1 158 | mover 51 (los anteriores) |
| **matriz CI raíz** (`tests/{unit,…}/`) | suites cross-cutting pesadas | 480 | **NO TOCAR** (orden explícita) |
| **plana operativa** (`ops/tests/`) | scripts Node/Python de operación, sin src/ propio | — | **NO TOCAR** (orden explícita — anclada por `validate.sh`) |
| **`test/` hermana operativa** (`ops/pty-agent/tests/`) | binario Python único en `ops/pty-agent/` | 218 | mover 19 |

## §2 — Plan de partición de gigantes

### §2.1 — GIGANTES DE LA ORDEN (autorizado ejecutar Tarea 2)

> **byte-puro**: bloques `test()` top-level COMPLETOS a ficheros hermanos planos (`engine-<area>.test.ts`). Helpers compartidos a `engine-fixtures.ts` (NO-test, mismo dir, no en subcarpeta — la orden es dura sobre el runner `dist/test/*.test.js` PLANO). Sin reescritura, sin refactor de comportamiento. Trinquete `calidad-base.json` se actualiza al final (renombra entradas; el baseline solo puede **bajar**).

#### §2.1.1 — `packages/adapter-sdk/test/engine.test.ts` (2 794 L, 72 tests)

**Sin `describe()`** (verificado — 0 ocurrencias en todo el paquete adapter-sdk). Tests sueltos top-level agrupados por afinidad temática.

| Fichero nuevo | Tests | Rango líneas original | Estimación | Tema |
|---|---:|---|---:|---|
| `engine-delivery-orchestration.test.ts` | 11 | 84–117 + 345–668 (1–11) | ~700 | accepted durable, concurrencia por session, cancelaciones, terminal output |
| `engine-prompt-and-input.test.ts` | 6 | 670–807 (12–17) | ~400 | rol al harness, unicode, trusted routing inventory |
| `engine-agent-response.test.ts` | 8 | 809–865 + 1389–1648 (18,19,28–31,36,37) | ~500 | reply null, stale epoch, relay cancel, ack budget, failure pre-started |
| `engine-continuations-and-fanin.test.ts` | 8 | 867–1387 (20–27) | ~770 | stateless continuation, fan-in nested, mismatched fan-in, agent fan-in reject |
| `engine-renewals-and-budget.test.ts` | 8 | 1468–1739 (32–35,38–41) | ~530 | renewals fsync, body timeout, ACK budget, retryable failure |
| `engine-recovery.test.ts` | 5 | 1741–1841 (42–46) | ~380 | recovery scenarios, retryable failure higher attempt |
| `engine-preinvoke-crash-recovery.test.ts` | 6 | 1843–2071 (47–52) | ~500 | crash recovery preinvoke-v1, duplicate started frame |
| `engine-session-identity.test.ts` | 11 | 2084–2352 (53–63) | ~700 | sessions autenticadas, originless, console, recipient, bridge tenant |
| `engine-media-and-branches.test.ts` | 9 | 2354–2794 (64–72) | ~770 | attachments, materialización, fan-in cerrado por child ids |
| **`engine-fixtures.ts`** (NO-test) | — | 22–336 + 119–336 (helpers) | ~280 | exports: `root`, `storeFor`, `claimToken`, `delivery`, `SUCCESS`, `class ControlledRunner`, `setup`, `sessionOf`, `conversation`, `originless` (10 símbolos; 5 helpers específicos de 1 fichero se quedan en el propio test) |

Total: 72 tests = 11+6+8+8+8+5+6+11+9 ✓. Cada fichero <800 L. Sin dependencias ordering-dependientes entre tests (cada test crea su propio `.test-state/<name>/`).

#### §2.1.2 — `packages/adapter-sdk/test/client.test.ts` (1 339 L, 25 tests + 4 subtests)

| Fichero nuevo | Tests | Rango líneas original | Estimación | Tema |
|---|---:|---|---:|---|
| `client-startup.test.ts` | 5 | 313–447 (1–5) | ~370 | lease, retry, siembra reconnect, heartbeat, perfil failure |
| `client-outbox-and-errors.test.ts` | 5 | 449–750 (6–10) | ~480 | outbox replay, ack_result, terminal delegation, inconclusive |
| `client-execution-intent.test.ts` | 8+2 | 752–1112 (11–18) | ~580 | execution-intent gate, duplicate receipt, fsync failure, ownership_lost |
| `client-claim-renewals.test.ts` | 3+2 | 1114–1286 (19–21) | ~310 | renewal receipts, claim watchdog |
| `client-connection.test.ts` | 4 | 1288–1339 (22–25) | ~120 | stale hello epoch, lease, ephemeral reject, backoff |
| **`client-fixtures.ts`** (NO-test) | — | 27–311 | ~280 | exports: `root`, `HelloAgentProfile`, `NoopRunner`, `FakeConnection`, `ScriptedConnector`, `SequenceConnector`, `makeClient`, `waitUntil`, `waitUntilTimestamp`, `CountingRunner`, `renewableDelivery`, `startedAcks` (12 símbolos) |

Total: 25 + 4 subtests = 29 ejecuciones ✓. Cada fichero <800 L. Test #4 muta `process.env.CAUCE_SEMBRAR_PERFIL` y `CLAUDE_CONFIG_DIR` restaurando en `finally` — anotado en el cuerpo.

#### §2.1.3 — `packages/adapter-sdk/test/durable-store.test.ts` (1 100 L, 20 tests + 31 subtests)

| Fichero nuevo | Tests | Rango líneas original | Estimación | Tema |
|---|---:|---|---:|---|
| `durable-store-canonical-opencode.test.ts` | 8 | 169–466 (1–8) | ~430 | canonical pointer, restart recovery, sessions backup |
| `durable-store-atomic-recovery.test.ts` | 1+24 | 468–546 (9, **24 subtests** = 6 atomic × 4 windows) | ~200 | SIGKILL recovery determinista |
| `durable-store-fsync-and-retry.test.ts` | 5 | 548–787 (10–14) | ~310 | fsync rollback, fan-in transition, retained TTL, retry fresh identity |
| `durable-store-lifecycle-frontiers.test.ts` | 6+7 | 815–1100 (15–20, **7 subtests**) | ~440 | lifecycle atomic frontiers, ACK removal, legacy split |
| **`durable-store-fixtures.ts`** (NO-test) | — | 18–167 | ~150 | exports: `root`, `scopeA`, `scopeB`, `freshStore`, `delivery`, `pointer`, `delegatedOutput`, `completedOutput`, `reopenWithArmedCommitFailure`, `type AtomicCrashWindow` (10 símbolos) |

Total: 20 + 31 subtests ✓. Cada fichero <800 L. `atomicCrashChild` y `crashChildAtAtomicWindow` solo los usa el test #9 → se quedan en `durable-store-atomic-recovery.test.ts` (no en fixtures).

**Invariante duro (orden §2)**: el total de tests `# pass` antes y después debe ser **idéntico**:
- Antes: `su stev -c 'cd packages/adapter-sdk && pnpm test'` → anotar.
- Después: mismo comando → `# pass` debe coincidir **exactamente** (verificación byte-pura).
- Trinquete `scripts/calidad-base.json`: las 3 entradas (`engine.test.ts:2795`, `client.test.ts:1340`, `durable-store.test.ts:1101`) **se renombran** a los 8+5+3=16 ficheros nuevos; si algún fichero nuevo supera 800 líneas (no debería) la entrada solo puede **bajar**.

### §2.2 — GIGANTES FUERA DE LA ORDEN (solo propuesta, NO ejecutar)

#### §2.2.1 — `services/gateway/src/terminal.plugin.test.ts` (2 020 L, 1 describe, 58 tests + 1 `it.each(×4)`)

Plan de partición (NO ejecutar en esta ronda):

| Fichero nuevo | Tests | Rango | Estimación |
|---|---:|---|---:|
| `terminal-plugin-list.test.ts` | 5 | 693–803 (A) | ~115 |
| `terminal-plugin-issuance.test.ts` | 14 | 806–1061 (B, incluye `it.each`) | ~265 |
| `terminal-plugin-attribution.test.ts` | 8 | 1063–1199 (C) | ~145 |
| `terminal-plugin-consume.test.ts` | 12 | 1184–1507 (D) | ~325 |
| `terminal-plugin-revoke.test.ts` | 12 | 1514–1869 (E) | ~360 |
| `terminal-plugin-directive.test.ts` | 10 | 1872–2019 (F) | ~150 |
| **`terminal.plugin.fixtures.ts`** | — | 1–691 (helpers + describe state) | ~430 |

**Riesgo**: el describe actual usa 12 variables del closure (`directory`, `grantsFile`, `database`, `registry`, `app`, `config`, `controlPermission`, `hechos`, `pedidas`, `leer`, `relayPeerInstanceId`, `relayBootId`) — extraerlas a un helper externo requiere pasarlas como parámetro. Recomendación para cuando se ejecute: empezar con `terminal-plugin-list.test.ts` validando el refactor, propagar después.

#### §2.2.2 — `services/gateway/src/health-progress.test.ts` (1 013 L, 1 describe, 31 tests)

| Fichero nuevo | Tests | Rango | Estimación |
|---|---:|---|---:|
| `health-probes-contract.test.ts` | 14 | 33–465 (A) | ~430 |
| `health-ready-endpoint.test.ts` | 9 | 467–712 (C) | ~245 |
| `health-wake-pump.test.ts` | 3 | 721–793 (W) | ~75 |
| `health-main-wiring.test.ts` | 1 | 714–719 (M) | ~10 |
| `health-postgres-integration.test.ts` | 1 | 795–1005 (P, timeout 120s) | ~215 |
| `health-backwards-compat.test.ts` | 1 | 1007–1013 (B) | ~10 |
| **`health-progress.fixtures.ts`** | — | 1–32 | ~30 |

Bajo riesgo (closures mínimos: solo `dataListener` + `afterEach`).

#### §2.2.3 — `packages/store/test/agent-output-postgres.test.ts` (2 730 L, 1 describe, 29 tests)

Mantiene `test/` hermana, runner `test:store-hardening`. 7 ficheros nuevos:

| Fichero nuevo | Tests | Rango | Estimación |
|---|---:|---|---:|
| `structured-output-ack-idempotency.test.ts` | 3 | 256–453 | ~230 |
| `structured-output-cross-tenant.test.ts` | 5 | 495–1090 | ~620 |
| `structured-output-forgery-rejection.test.ts` | 2 | 1327–1397 | ~90 |
| `structured-output-retry-materialization.test.ts` | 5 | 1425–1597 | ~195 |
| `structured-output-all-expansion.test.ts` | 5 | 1606–1826 | ~245 |
| `structured-output-bounce-relay.test.ts` | 4 | 1873–2115 | ~265 |
| `structured-output-fanin-rollback.test.ts` | 7 | 2303–2730 | ~460 |

#### §2.2.4 — `packages/store/test/dlq-causal-reconciliation-postgres.test.ts` (1 406 L, 2 describe, 17 tests)

Mantiene `test/` hermana. 4 ficheros nuevos (sin `dlq-fixtures.ts` propio — reusa setup global):

| Fichero nuevo | Tests | Rango |
|---|---:|---|
| `dlq-causal-apply-concurrency.test.ts` | 4 | 250–587 |
| `dlq-causal-resolve-races.test.ts` | 5 | 587–771 |
| `dlq-operator-replay.test.ts` | 3 | 773–992 |
| `dlq-operator-no-replay.test.ts` | 5 | 992–1406 |

#### §2.2.5 — `packages/store/test/console-publish-intent-postgres.test.ts` (981 L, 1 describe, 24 tests)

Mantiene `test/` hermana. 3 ficheros nuevos:

| Fichero nuevo | Tests | Rango |
|---|---:|---|
| `console-publish-intent-replays.test.ts` | 9 | 114–390 |
| `console-publish-intent-rate-limit.test.ts` | 8 | 455–716 |
| `console-publish-intent-expiry-audit.test.ts` | 7 | 754–981 |

#### §2.2.6 — `packages/store/test/egress-notification-postgres.test.ts` (822 L, 8 describe, 32 tests)

**NO partir**: ya viene fragmentado por 8 `describe()` canónicos (subdominios del dominio). Mantener tal cual.

#### §2.2.7 — `tests/gateway-hardening/delivery-admission.test.ts` (916 L, 1 describe, 15 tests)

Mantiene `tests/gateway-hardening/` (matriz CI raíz, NO se fusiona). 3 ficheros nuevos:

| Fichero nuevo | Tests | Rango |
|---|---:|---|
| `delivery-admission-budget.test.ts` | 7 | 221–535 |
| `delivery-admission-fencing.test.ts` | 5 | 574–801 |
| `delivery-admission-rehydrate.test.ts` | 3 | 801–916 |

#### §2.2.8 — `tests/gateway-hardening/gateway-security.test.ts` (849 L, 2 describe, 24 tests)

2 ficheros nuevos (mantiene la matriz CI):

| Fichero nuevo | Tests | Rango |
|---|---:|---|
| `gateway-security-rbac.test.ts` | 20 | 44–760 |
| `gateway-security-egress.test.ts` | 4 | 761–849 |

#### §2.2.9 — `tests/store-hardening/adversarial-postgres.test.ts` (857 L, 1 describe, 18 tests)

Mantiene `tests/store-hardening/`. 3 ficheros nuevos:

| Fichero nuevo | Tests | Rango |
|---|---:|---|
| `adversarial-ack-lease.test.ts` | 5 | 72–278 |
| `adversarial-event-id-acl.test.ts` | 5 | 363–561 |
| `adversarial-recovery-pool.test.ts` | 8 | 617–857 |

## §3 — Mapa de `packages/adapter-sdk/test/shared-session.test.ts` (5 444 L, 115 tests — NO TOCAR)

> Para que Codex/futuro lo ejecute con este mapa. Sin `describe()` (igual que los demás adapter-sdk). Imports únicos del fichero (1–73): `node:{assert/strict,fs/promises,path,os,child_process,test,crypto}` + `../src/sdk/durable-store.js` + `../src/harnesses/shared.js` + `../src/harnesses/index.js` + `../src/shared-session/{tmux,paste-runner,notice,degradation-log,pane,transcript,rollout,session,resume,types,config}.js`.

| # | Línea1er test | # tests | Tema dominante |
|---:|---:|---:|---|
| 1–8 | 908–1170 | 8 | claude transcript (cosecha del sobre, aviso degradado, sesión reiniciada) |
| 9–15 | 1249–1494 | 7 | codex rollout + compactación + Enter ambiguo |
| 16–25 | 1496–1968 | 10 | cancelaciones y tmux barrera (fake + real) |
| 26–29 | 1970–2147 | 4 | tmux real: cliente post-captura, mutación con identidad, atomicidad |
| 30 | 2156–2198 | 1+5 | paste triestado con `for` (5 escenarios) |
| 31–37 | 2200–2646 | 7 | load-buffer, probe, delete, overwrite, persist, cancelaciones pre-paste |
| 38–48 | 2648–3055 | 11 | commitPrepared CAS, hooks tmux, fake-tmux post-Enter, abort load |
| 49–58 | 3127–3574 | 10 | cancelaciones post-Enter, screen ocioso, quarantine-pending, cleanup CAS |
| 59–70 | 3609–4054 | 12 | scan transcript, clearDegradation, Enter ambiguo (no C-u), respawn-pane, tui_absent |
| 71–76 | 4060–4272 | 6 | funciones puras: inputBoxState, no-heredar-identidad, cursor codex, vallado Markdown |
| 77–82 | 4274–4471 | 6 | compactación a mitad de turno, /clear, resucitar, declave |
| 83–92 | 4477–4733 | 10 | entorno TUI, ventana extra-pane, marker harness incorrecto |
| 93–103 | 4735–5035 | 11 | ensure concurrentes, CAS atomic, tmux real, kill por nombre |
| 104–115 | 5035–5444 | 12 | (resto) ciclos de error, replay quarantine, finalize |

Total: 115 tests + 9 subtests generados en bucles `for` (5+2+2). Pre-flight check (líneas 76–79) aborta la suite si falta `tmux` o `script` — anotación para futura partición: cada fichero nuevo necesitará ese pre-flight o el guard debe vivir en `shared-session-fixtures.ts`.

Helpers raíz (74–902) — piezas grandes exportables:
- `stateRoot`, `EXACT_TMUX_PANE_STATE_FORMAT` (81–95), `exactTmuxPaneState` (97–103), `exactTmuxPaneStateViaList` (105–113)
- `ENVELOPE` (115–121), `envelopeText` (123–129), `correlationIdFromPrompt` (131–135)
- `freshState` (137–145), `userEntry` (148–153), `assistantEntry` (155–166)
- `class FakeTmux` (173–741) — pieza grande; uso transversal en tests 22–70+
- `ok` (743–745), `ambiguousTmuxResult` (747–749)
- `controlledTmuxHang` (752–773), `controlledDelayedTmuxMutation` (775–806)
- `class RecordingFallback` (809–818)
- `claudeRunner` (822–873), `adapterFor` (875–889), `execute` (891–902)

## §4 — Propuesta de convención ÚNICA

**Estado actual** (5 reglas implícitas — ver §1):
1. **junto-al-fuente** (`src/*.test.ts`): `console/`, `gateway/`, `terminal-relay/`, `mcp-fleet-monitor/`, `store/src/` (excepción).
2. **`test/` hermana** (`test/*.test.ts`): `adapter-sdk/`, `protocol/`, `dispatcher/`, `telegram-bridge/`, `store/test/`.
3. **matriz CI raíz** (`tests/{unit,…}/`): suites pesadas cross-cutting.
4. **plana operativa** (`ops/tests/`): mezcla Node/Python/bash sin src/.
5. **`test/` hermana operativa** (`ops/pty-agent/tests/`): un binario Python único.

### §4.1 — Recomendación final: **C — matriz mixta justificada**

> Una convención POR categoría justificada, no una convención universal forzada.

**Reglas declarativas (objetivamente aplicables):**

| # | Categoría | Convención | Justificación |
|---|---|---|---|
| 1 | Librerías puras (`packages/{adapter-sdk,protocol,store}`) | `test/` hermana | Los tests son contratos externos — no viven con el código. Es la convención que YA cumplen 105 ficheros con éxito. |
| 2 | Servicios + apps (`services/*`, `console`, `packages/mcp-fleet-monitor`) | junto-al-fuente (`src/`) | Estilo aplicación — los tests viven con el módulo que prueban. La MAYORÍA (66 ficheros) ya cumple. Solo `dispatcher` y `telegram-bridge` rompen. |
| 3 | Suite operacional (`ops/tests/`, `ops/pty-agent/tests/`) | plana junto a la fuente operativa que cubren | Tests Node/Python/bash contra scripts operativos múltiples. Moverlos rompe `OPS = parents[1]` y `validate.sh`. |
| 4 | Tests de integración/E2E (`tests/{unit,…}/`) | matriz CI raíz | Suites cross-cutting pesadas — separarlas del código fuente es **la razón de existir** del dir. |

**Cambios necesarios para aplicar C** (NO ejecutar — el dueño firma primero):

| Cambio | Ficheros | Líneas config |
|---|---|---:|
| `git mv` de `services/dispatcher/test/*.test.ts` → `services/dispatcher/src/*.test.ts` | 3 | — |
| `git mv` de `services/telegram-bridge/test/*.test.ts` → `services/telegram-bridge/src/*.test.ts` | 19 | — |
| `services/dispatcher/package.json` `test/*` → `src/*` | 1 | 1 |
| `services/telegram-bridge/package.json` `test/*` → `src/*` | 1 | 1 |
| `services/dispatcher/tsconfig.json` quitar `exclude: ["src/**/*.test.ts"]` | 1 | 1 |
| `docs/mapa-de-ficheros.md` §4 "operativa" | 1 | ~5 |

**Coste total C**: 22 `git mv` + 3 líneas de config + ~5 líneas de docs = **2 commits** (`git mv` por workspace + 1 commit de config). NO toca `ops/tests/` (anclado por 8 invocaciones de `validate.sh`). NO toca Python (sin riesgo `OPS = parents[1]`). NO toca runners `--test-concurrency=1` (es del adapter-sdk, que ya cumple). NO toca runners `--testTimeout` (son de la matriz CI, no se mueve).

**Comparación con A y B** (rechazadas):

| Métrica | A: todo junto-al-fuente | B: todo `test/` hermana | **C: matriz mixta** |
|---|---:|---:|---:|
| # ficheros movidos | ~150 | 53 | **22** |
| # líneas config | 60–90 | 30–40 | **3** |
| # workspaces afectados | 7 | 4 | **2** |
| # commits `git mv` separados | ~10–13 | ~7 | **2** |
| Rompe `OPS = parents[1]` en Python | SÍ | NO | **NO** |
| Rompe `validate.sh` (8 invocaciones) | SÍ | NO | **NO** |
| Rompe `container_ops_digest.py --check` | SÍ | NO | **NO** |
| Rompe `test_suite_completeness.py` | SÍ | NO | **NO** |
| Rompe `console/src/test/setup.ts` path | NO | SÍ | **NO** |

**Recomendación firme: C.** Cumple la orden ("UNA convención") en el sentido de "una convención POR categoría justificada y declarativa", con coste mínimo y riesgo cero sobre las zonas frágiles (Python, `validate.sh`, `container_ops_digest.py`). NO esconde el problema P16 (7 `test_*.py` huérfanos siguen visibles donde están).

### §4.2 — Decisiones pendientes del dueño (separadas de la convención)

- **P16**: 7 `test_*.py` huérfanos (`alias_lock_exec`, `config_por_alias_supervisor`, `container_runtime_zombies`, `fleet_watchdog`, `quota_collector`, `schema_error_sanitization`, `verify_hermes_runtime`) — añadir al gate o `git rm`. Ya documentado en `minimax-cobertura-gate.md:103-106`.
- **`ops/scripts/fault-compose.test.sh`** (74 L, bash) — huérfano puro: no lo invoca nadie. `git rm` o añadir al gate.
- **`shared-session.test.ts`** (5 444 L) — pendiente de partición futura; mapa en §3.

## §5 — §helpers — duplicados/casi-duplicados entre paquetes

| Grupo | Ficheros | Hogar propuesto | Notas |
|---|---|---|---|
| **`tests/helpers/postgres.ts`** | **46 importadores** (41 en `store/test/`, 9 en `store-hardening/`, 3 en `gateway-hardening/`, 2 en `telegram-bridge/test/`) | `tests/helpers/postgres.ts` (NO TOCAR — anclado, orden explícita) | Helper canónico de PostgreSQL. Único en su categoría. |
| **`bridge-fixtures.ts`** | 4 importadores (`bridge.test.ts`, `bridge-egress.test.ts`, `bridge-ingress.test.ts`, `bridge-lifecycle.test.ts`) | `services/telegram-bridge/test/bridge-fixtures.ts` (ya existe, 392 L) | Helper NO-test del paquete. Sin duplicación fuera. |
| **`relay-test-fixtures.ts`** | 1–2 importadores (subagente 2 no confirmó; sigue bajo `services/terminal-relay/src/`) | mismo dir (NO-test) | Único. |
| **`tests/terminal-pty/certs.mjs`** | 1 importador (`services/terminal-relay/src/health.test.ts`) | `tests/terminal-pty/certs.mjs` | Único. |
| **`ops/tests/fake-{container-supervisor,docker,gate-collector,gate-roundtrip-probe,systemctl}.mjs`** | `container-supervisor.test.mjs` + `container-cutover.test.mjs` + `tests/unit/canary-gate.test.ts` | `ops/tests/fake-*.mjs` | 5 fakes, 3 importadores entre suites. Hardcoded paths en `tests/unit/canary-gate.test.ts:42-43` y `container_ops_digest.py:29-48` — riesgo si se mueven. Propuesta: dejarlos en `ops/tests/` (regla 3 de §4.1). |
| **`ops/tests/fixtures/`** (3 ficheros + `fake_quota_server.py`) | `test_quota_collector.py` | `ops/tests/fixtures/` | Único importador real. |
| **`console/src/test/{setup.ts,render.tsx,css-parser.ts,leer-css.ts}`** | 9 importadores en `console/src/` | `console/src/test/` | 4 helpers NO-test, 9 importadores. Convención "test/" hermana operativa (mismo dir que el código que prueban). Sin duplicación fuera. |
| **`console/src/mocks/{handlers,browser,data,server,terminal-demo,terminal-ticket}.ts`** + `mocks/fixtures/` | 5 importadores (`api.test.ts`, `registry.test.ts`, `agent-state-derivation.test.ts`, `licenses.test.ts`, `activity.test.ts`) | `console/src/mocks/` | 6 mocks + 4 fixtures. Sin duplicación fuera. |
| **`packages/store/src/fleet-activity.test.ts`** + **`packages/store/src/repository.quota-schema-version.test.ts`** | 2 ficheros en `packages/store/src/` | mismo dir (excepción documentada en §4.1 regla 1) | Mezcla existente: conviven con el código fuente a pesar de que el paquete sigue convención `test/` hermana. Decisión: documentar como excepción o mover a `packages/store/test/` (1 commit, 0 impacto). |
| **`packages/store/test/*.test.ts` con `import { … } from '../../../tests/helpers/postgres.js'`** | 41 ficheros | import relativo estable | Patrón uniforme, sin duplicación. NO TOCAR. |

**Veredicto §helpers**: NO hay duplicación significativa entre paquetes. Cada helper/fixture tiene UN hogar canónico y se importa desde 1–46 ficheros. La excepción menor son los 2 ficheros en `packages/store/src/` que rompen la regla 1 — pero son 2 ficheros y se documentan como excepción.

## §6 — Riesgos identificados para Tarea 2

1. **`engine-fixtures.ts` exporta 10 símbolos; `client-fixtures.ts` 12; `durable-store-fixtures.ts` 10** — total ~640 líneas de fixtures + 8+5+3=16 ficheros nuevos de test. Sin ciclos de import (cada fixtures solo importa de `node:*` + `../src/*`).
2. **`test.concurrency=1` en adapter-sdk** (orden §2): los tests nuevos NO introducen estado mutable compartido (cada test crea su `.test-state/<name>/` con nombre único). El flag se mantiene por seguridad ante event-loop async.
3. **Bloque 25 del engine.test.ts (test `every harness runtime bypasses providers and native sessions for agent fan-in`)** usa internamente `CountingHarnessAdapter` y `optionalFile` — únicos a ese test, se quedan dentro del fichero `engine-continuations-and-fanin.test.ts`, NO se exportan desde fixtures.
4. **Test 9 del engine.test.ts (suite con 24 subtests `t.test`)** no comparte estado con otros tests. La partición en 8 ficheros separa los temas pero conserva el orden de ejecución original del adaptador (`setup()` es determinista; no hay race entre `.test-state/<name>/` carpetas separadas).
5. **`scripts/calidad-base.json`** — la orden §2.4 dice "renombra/reparte, el baseline solo baja". Las 3 entradas (`engine.test.ts:2795`, `client.test.ts:1340`, `durable-store.test.ts:1101`) se renombran a los 16 ficheros nuevos (3 fixtures NO entran porque no son test). Si tras la partición TODOS los nuevos están <800, la sección `lineas` queda con solo `shared-session.test.ts:5455` y `shared-session-turn-merge.test.ts:812` de los adapter-sdk, más los demás gigantes de otros paquetes.
6. **Gate verde** — la orden §2 exige `pnpm typecheck && pnpm lint && pnpm test:unit` en verde. Los nuevos `engine-*.test.ts`, `client-*.test.ts`, `durable-store-*.test.ts` entran en `test:unit` (el adapter-sdk corre bajo `test:unit`). Sin cambios de config, los runners los recogen automáticamente (`dist/test/*.test.js` PLANO los incluye sin subcarpeta).