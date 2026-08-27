# OpenCode/MiniMax — ORDEN ACTIVA (sesión nueva: NO necesitas historial; todo está aquí)

ARRANQUE: (1) `cd /datos/workspaces/zeus/cauce-v3 && git pull`; (2) lee `ordenes/00-PROTOCOLO.md`; (3) esta orden entera; (4) verifica con comandos qué existe ya. Reglas: directo a main, commit con pathspec, prohibido clean/reset/stash/ramas, nada de código de producto (.ts/.tsx/.py/.sh de src). **LANZA 4 SUBAGENTES EN PARALELO** (tope 4 — con 6 da rate limit); solo tú commiteas; push al cerrar cada tarea. Tus fortalezas: contexto larguísimo y constancia — estas tareas son de leer mucho y no rendirse.

## Tarea 1 — Las dos suites largas (déjalas TERMINAR, tardan)
Como usuario normal: `pnpm test:integration` y después `pnpm test:e2e`. Resumen de cada una (ficheros/tests verdes/rojos, duración) → `ordenes/reportes/minimax-matriz-cd.md`. Rojos: NO arregles nada; lista cada uno con su error textual. `docker ps` antes/después (cero contenedores huérfanos).

## Tarea 2 — Lectura TOTAL → `docs/mapa-de-ficheros.md` (4 subagentes, un grupo de directorios cada uno)
`git ls-files` filtrado a .ts/.tsx/.mjs/.py/.sh sin tests (~400): LEE cada fichero y escribe UNA línea: `ruta — qué hace de verdad — sector dueño`. ⚠ donde el nombre mienta. Tests: una línea por SUITE. Agrupado por directorio con subtotales.

## Tarea 3 — Verificar los 105 candidatos huérfanos de `docs/grafo.md`
El grafo (ya existe, sección "Candidatos huérfanos") lista 105 ficheros fuente sin referencia entrante detectada. Para CADA uno (repártelos entre 4 subagentes): re-verifica con `git grep` del basename Y de sus exports principales + revisa si es entry-point legítimo (bin/, main, config, referenciado por Dockerfile/compose/systemd/manifests). Produce `ordenes/reportes/minimax-huerfanos.md`: tabla veredicto huérfano-confirmado / falso-positivo (con la referencia que lo salva). NO borres nada — el integrador ejecuta.

## Tarea 4 — Basura v3
`git status --ignored --porcelain` + `du -sh` de cada ignorado presente en disco: borra lo regenerable inequívoco (caches, builds), tabla de lo dudoso en el mismo reporte de huérfanos.

## Tarea 5 — Mantenimiento
`PENDIENTES-DEL-DUEÑO.md` al día; reportes de `ordenes/reportes/` ya consumidos → `git rm` con evidencia; enlaces sin rutas muertas.

Reporte final ≤5 líneas por tarea + `git push origin main`.
