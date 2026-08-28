# OpenCode/MiniMax — ORDEN ACTIVA (sesión nueva; 4 subagentes; LA RONDA DE ORDEN DE LOS TESTS)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden → verifica con comandos. El dueño te eligió para esto por tu fuerte: contextos gigantes y trabajo masivo mecánico. ESTA RONDA SÍ editas código de test (asignación temporal del integrador sobre los ficheros EXACTOS listados — ni uno más). Reglas: 4 subagentes, gate global por commit como usuario normal con `umask 022`, commit+push POR TAREA, byte-puro (los tests se MUEVEN, no se reescriben).

## Restricciones CONGELADAS (violarlas = revertir)
- NO fusionar los directorios top-level de tests/ (son la matriz de CI: test:unit/gateway-hardening/store-hardening/…).
- NO tocar `tests/helpers/postgres.ts` (anclado por 46 ficheros).
- NO tocar `packages/adapter-sdk/test/shared-session.test.ts` NI `harnesses.test.ts` (Codex está DENTRO ahora mismo).
- El runner de adapter-sdk solo ejecuta `dist/test/*.test.js` PLANO: los ficheros partidos van como HERMANOS planos (`engine-<area>.test.ts`), jamás en subcarpeta.

## Tarea 1 — CENSO+PLAN MAESTRO del orden de tests (solo lectura, tu especialidad)
Inventario de TODOS los `*.test.*` del árbol: zona, líneas, runner que lo ejecuta (cruza con tu `minimax-cobertura-gate.md`), convención (junto-al-fuente vs `test/` hermana), helpers que importa. Entregable `ordenes/reportes/minimax-orden-de-tests.md`: (a) tabla completa; (b) plan de partición de CADA gigante >1.000 líneas con rangos de bloque exactos y fixtures compartidas a extraer (incluye shared-session 5.444 para que Codex/futuro ejecute con tu mapa); (c) propuesta de convención ÚNICA de ubicación (hoy: gateway+relay+console junto-al-fuente, dispatcher+bridge en test/ — el dueño quiere orden: recomienda UNA con la lista completa de movimientos + cambios de config/globs y su coste) — NO la ejecutes: el dueño firma primero.

## Tarea 2 — EJECUTAR la partición de los 3 gigantes de adapter-sdk SIN conflicto
`packages/adapter-sdk/test/engine.test.ts` (2.794) · `client.test.ts` (1.339) · `durable-store.test.ts` (1.100). Método byte-puro por fichero:
1. ANTES: `su stev -c 'cd packages/adapter-sdk && pnpm test'` y anota el total exacto de tests (`# pass`).
2. Mueve bloques `test()/describe()` COMPLETOS a hermanos planos por área de comportamiento (`engine-recovery.test.ts`, `engine-session-queue.test.ts`, `client-…`, `durable-store-…`); fixtures/helpers compartidos a un fichero NO-test (`engine-fixtures.ts`) importado por todos.
3. DESPUÉS: mismo comando — **el total de tests debe ser IDÉNTICO** (invariante duro; si baja uno, algo se perdió). Cada fichero nuevo <800 líneas.
4. Re-clava las claves del trinquete de los ficheros partidos en `scripts/calidad-base.json` (renombra/reparte, el baseline solo baja) y gate global verde.
OJO `--test-concurrency=1` existe por orden/estado compartido: si un bloque depende de otro ANTERIOR en el mismo fichero, mantenlos juntos en el mismo hermano y anótalo.

## Tarea 3 — Helpers de test regados (censo, solo lectura)
Helpers/fixtures duplicados o casi entre paquetes de test que Gemini/Codex no cubrieron ya: tabla grupo → ficheros → hogar propuesto, en el mismo `minimax-orden-de-tests.md` §helpers.

Push por tarea + reporte ≤5 líneas por tarea.
