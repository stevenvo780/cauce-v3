# Órdenes — Codex Terra · Ronda 5 (RELEVO del sector `apps/console/**`)

Eres nuevo: lee PRIMERO `AGENTS.md` (raíz) y `ordenes/00-PROTOCOLO.md` completo. Reglas duras: directo a main, **commit con pathspec** (`git commit <tus rutas> -m ...`), `git add` solo por rutas propias, gate antes de cada commit, push al cerrar, subagentes con ficheros disjuntos (máx. 4) y solo tú commiteas. Tu sector: `apps/console/**` (heredas a Gemini, agotado). Tu revisor: Claude (integrador).

## Tarea 0 — Levantar acta del estado heredado (antes de tocar nada)
1. `pnpm --filter @cauce/console test` — anota ficheros/tests en rojo (la última medición conocida: 13 tests rojos en 6 ficheros, restos de un problema de entorno ya mitigado).
2. `git log --oneline --since='2026-08-27 03:40' -- apps/console` — familiarízate con lo que Gemini partió hoy (styles.css, live.css, OperatorWorkspace, pty-session, licenses.css).
3. Si el integrador publicó hallazgos de su revisión sobre esas particiones (`ordenes/reportes/` o te lo pasa el dueño), **arreglarlos es tu prioridad absoluta**.

## Tarea 1 — Rematar los tests rojos (desbloquea el gate global)
Arregla las causas de los rojos restantes. PROHIBIDO debilitar aserciones o poner `skip` para forzar verde. Si un test revela un bug real de producto: NO toques el producto — repórtalo en `ordenes/reportes/codex-terra-bugs-reales.md` con archivo:línea y déjalo rojo. Meta: 107/107 ficheros verdes o lista corta de bugs documentados. Al lograrlo, avisa: `pnpm test:unit` entra al gate global.

## Tarea 2 — Partir `DirectivaModal.tsx` (577 líneas) y lo que quede >500 en `features/live/`
Mismo método que las particiones previas: por responsabilidad, cero cambios de comportamiento, imports/exports con paridad, ningún hook reordenado. Tests pasan sin editar (salvo imports).

## Tarea 3 — Barrido de exports muertos en `apps/console/src`
Símbolos exportados que nadie importa (excluye entry points de Vite y usos en tests): bórralos con la evidencia en el mensaje de commit. Ante APIs dudosas, conservar y listar.

## Tarea 4 — (CONDICIONAL: solo si el dueño ya decidió sobre `ordenes/reportes/gemini-vistas-sin-uso.md`)
Ejecutar vista por vista: conservar / `git mv` a `_legado/consola/`. Sin decisión → saltar y decirlo.

Gate por commit: `pnpm --filter @cauce/console typecheck && pnpm --filter @cauce/console lint` + conteo de tests igual o mejor. Al terminar TODO: `git push origin main` + reporte ≤5 líneas.
