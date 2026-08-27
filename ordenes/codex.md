# Codex — ORDEN ACTIVA (sesión larga; oleadas de 4; sector: store + gateway + protocol/adapter-sdk/mcp + ops/{scripts,tests,harness,schemas})

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden → verifica con comandos. Evidencia madre: `ordenes/reportes/claude-megaauditoria.md` §3.1. Reglas: main directo, pathspec, sin clean/reset/stash, gate como usuario normal con `umask 022` (correr como root ahora está BLOQUEADO por guardia), **COMMIT+PUSH AL CERRAR CADA TAREA — tu ronda anterior dejó la cosecha sin commitear y las 2 tareas difíciles sin tocar: esta vez las difíciles van PRIMERO.**

## Tarea 1 (CARRYOVER, obligatoria antes que nada) — el rojo determinista del supervisor
`ops/tests/container-supervisor.test.mjs` falla SIEMPRE en la barrera de flock (~línea 1127; `waitForLogOrExit` 15s, ~línea 293): el primer supervisor lanzado se CUELGA antes del docker-exec falso (no sale — se queda). Llegó en `c7345da` y plausiblemente jamás pasó en esta máquina. Investiga arnés vs producto (¿`container-adapter-supervisor.sh` se bloquea en el flock del fixture, o el fixture arma mal la barrera?). Si es producto, es un cuelgue REAL de arranque. Cierra con el test completo VERDE y pega la duración.

## Tarea 2 (CARRYOVER, obligatoria) — los 14 skips ambientales
12 en `packages/adapter-sdk/test/shared-session.test.ts` (tmux) + 2 en `harnesses.test.ts` (plataforma). El gate NUNCA los corre. Garantiza tmux en el entorno del gate y quita el skip, o convierte la ausencia en FALLO ruidoso. Que el gate los ejecute de verdad y pega el conteo.

## Tarea 3 — Lista §3.1 de la mega-auditoría (los ejecutables)
1. `ops/scripts/validate.sh:6,197`: amplia ambos globs a los 10 `.sh` fuera (empieza por `scripts/test.sh`).
2. `packages/mcp-fleet-monitor/package.json`: añade `esbuild` (pin de la raíz) y `@types/pg` a devDependencies (fallos verificados ocultando los de la raíz).
3. `packages/store/src/repository/messages/_insert.ts` nuevo: `insertMessage`/`insertDelivery` con lista de columnas exportada; migra los 7 INSERT de messages y 6 de deliveries (y el INSERT…SELECT de `outbox/operator.ts:227`) en el MISMO cambio.
4. `packages/protocol/src/schemas.ts` (1.093): parte por dominio de mensaje, barril re-export intacto.
5. `ops/scripts/host-backup.sh:102`: quita la fecha del comentario, conserva la restricción.
6. `packages/mcp-fleet-monitor/src/server.ts:253,261`: `shutdown(signal)` con try/catch, `process.once(..., () => { void shutdown(...) })`.
7. Traspaso del ACK: avisa en tu reporte que `services/telegram-bridge/src/types.ts` (Gemini) puede importar de `@cauce/protocol/outbox-contracts` — dato: tus campos son `readonly`, los suyos mutables.

## Vigilancia (NO tocar hoy): `session-control.ts` (785), `container-adapter-supervisor.sh` (976), `chain-control/materialization.ts` (778), `mutations.ts` (728), `runner.mjs` (718) — no los engordes.
