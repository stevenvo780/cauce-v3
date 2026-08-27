# Órdenes — OpenCode/MiniMax · Ronda 2 (rutina rápida, sin tocar código de producto)

Protocolo vigente: `ordenes/00-PROTOCOLO.md` (directo a main, `git add` solo tus rutas, `git diff --cached` antes de commitear, push al cerrar). Prohibido tocar `.ts/.tsx/.py` de producto, `deploy/`, migraciones, `ops/scripts` (Codex está ahí).

## Tarea 1 — CI mínima en GitHub Actions
El repo ya está sincronizado con GitHub (solo `main`). Crea `.github/workflows/ci.yml`: en cada push a main → checkout, Node 22, pnpm 11.8, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`. Deja `pnpm test:unit` COMENTADO con una línea: "activar cuando ordenes/ronda1/codex.md tarea 2 cierre (hoy hay 533 fallos preexistentes de entorno)". Es la primera CI en la historia del repo: verifica el YAML con cuidado (sintaxis, versiones de actions oficiales, cache de pnpm).

## Tarea 2 — Índice humano de `docs/bitacora/`
La bitácora tiene ~40 ficheros. Reescribe `docs/bitacora/README.md`: tabla con una fila por fichero — nombre, fecha (del nombre o de git), y UNA línea de qué es ("handoff de zeus a codex sobre la directiva", "plan de reforma de consola", …). Mantén la advertencia de que nada de ahí describe el presente.

## Tarea 3 — Verificación de los 14 runbooks vivos
Para cada fichero que queda en `ops/runbooks/` (alerting, alias-cutover, authentication, backup-restore, container-adapters, e2e-integration, encender-un-alias, fleet-watchdog, ha, incident, quota-collector, systemd, telegram-cutover, enable-cycle-cut.sql): comprueba sus afirmaciones contra la realidad actual (¿los comandos que cita existen?, ¿las unidades/rutas que menciona son las reales?, ¿referencia cosas que ya están en `_legado`?). Reporte en `docs/bitacora/reportes/minimax-runbooks.md`: por runbook → vigente / desactualizado en X / debería ir a bitácora. NO los edites tú; el integrador decide con tu tabla.

## Tarea 4 — Verificación de los ADR
`docs/adr/` tiene 6 ADRs de julio. Misma mecánica: ¿cada decisión sigue describiendo el sistema real post-cuarentena (shadow-router y relay-worker ya no existen, la maquinaria de release se retira)? Reporte en `docs/bitacora/reportes/minimax-adr.md`: vigente / superado por X / contradice el estado actual.

Al terminar TODO: `git push origin main` y reporte de ≤5 líneas.
