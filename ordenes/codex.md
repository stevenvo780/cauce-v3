# Órdenes — Codex ultra (sector: store + gateway + maquinaria de release)

Lee `ordenes/00-PROTOCOLO.md` primero. Trabaja DIRECTO en `main` del checkout principal: commits pequeños con gate, `git add` solo de tus rutas, prohibido crear ramas. Tienes subagentes: úsalos con ficheros DISJUNTOS por subagente, máximo 4 concurrentes, y tú integras — la auditoría midió que el fan-out sin dueño único por fichero produjo 10 versiones simultáneas del mismo fichero. Detalle de fondo: `plan-reestructura/12` (final), `13` y `21`.

## Tarea 1 — Terminar la cuarentena de la maquinaria de release
Claude ya movió a `_legado/`: shadow-router, relay-worker, rollback-bridge (+ tests/scripts dedicados). Falta lo grande (ver `_legado/README.md`, sección "Pendiente"):
1. `git mv` a `_legado/ops-scripts/`: `deploy-release.sh`, `pin-production-release.py`, `release-writer-state.py`, `release-candidate.py`, `release-gate.sh`, `release-build.sh`, `release-console.sh`, `rollback.sh`, `cutover-rollback.sh`, `restore.sh`, `rollback-baseline.py`, `verification-rounds.mjs`, `capture-release-writer-snapshot.sh`, `bootstrap-prod-env.py`, `fleet-gate-mode.sh` (verifica con `git grep` qué más pertenece al conjunto — p.ej. `deploy.py`, `existing-gate.sh`, `future-*-gate.*`, `untracked-emergency-gate.py`, `source-digest.py` si solo lo usa la maquinaria).
2. Mueve con ellos sus tests de `tests/unit/`: deploy-release, pin-production-release, release-build-rc, release-writer-state, release-console-retired, restore-release-integrity, rollback-baseline, rollback-runtime, source-digest-closure, bootstrap-prod-env, fleet-maintenance-mode, migrate-cli-production y compose-files **si y solo si** su sujeto se mueve (compose-files también valida compose vivos: si mezcla, pártelo como hizo Claude con adversarial-postgres — mitad viva se queda, mitad legado se va).
3. Recorta `ops/Makefile`: elimina los targets `release-*`/`prod-up`/`prod-down` que invocan lo movido (deja `manifests`, backups y lo vivo). En `ops/scripts/validate.sh` quita la línea que ejecuta `ops/tests/container-release-pin.test.mjs` y mueve ese test (y `container-cutover.test.mjs` si depende de lo movido) a `_legado/`. En `package.json` elimina `verify:three-rounds`, `evidence:release-candidate` y los `qa:*`/`test:*` que queden huérfanos; actualiza `scripts/test-all.mjs` en consecuencia.
4. Actualiza `_legado/README.md` (tacha lo pendiente que completes).

## Tarea 2 — Fix del entorno de test de consola (desbloquea 533 tests)
Única causa: `RequestInit: Expected signal … to be an instance of AbortSignal` (polyfill de realm distinto). Punto de arreglo: `apps/console/src/test/setup.ts` (hoy solo parchea matchMedia/getContext). El constructo ofensor: `apps/console/src/api/client.ts:265,275` y `features/terminal/api.ts:188,207`. Es tu única excepción de sector (1 fichero de setup en apps/console); Gemini está avisada. Al cerrar: `pnpm test:unit` COMPLETO en verde → desde ahí, test:unit entra al gate global de todos.

## Tarea 3 — Partir `packages/store/src/repository.ts` (~11.000 líneas, 74 métodos)
Plan de corte en `plan-reestructura/13-carpinteria-backend.md` (módulos: messages, deliveries, outbox, jobs, config, agents, observability, quotas; la clase queda como fachada). REGLA DURA: cero cambios de lógica ni de SQL — solo mover y cablear imports. Los tests de `packages/store/test` pasan sin editar (salvo imports). Un commit por módulo extraído.

## Tarea 4 — Partir `services/gateway/src/app.ts` y `terminal/plugin.ts`
Mismo plan (13): rutas core / console / health; en terminal: control de sesiones / proxy relay / sondas de gobierno. Las rutas de publish-intents y chain-gates (muertas en producción: 0 filas, 0 llamadores) van a un módulo `routes/legado-candidato.ts` tras un flag, para que la tala futura sea un `git rm`.

## Gate por commit
`pnpm typecheck && pnpm lint` (+ `pnpm test:unit` desde que cierres la Tarea 2). Pega la salida en el reporte. Nada de "hecho" sin gate pegado.
