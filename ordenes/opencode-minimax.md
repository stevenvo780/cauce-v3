# OpenCode/MiniMax — ORDEN ACTIVA (continuación de las largas + huérfanos del mapa)

Protocolo de siempre. Si las tareas largas previas (suites integration/e2e, mapa-de-ficheros) siguen a medias: **termínalas primero** — son tuyas y nadie más las hará.

## Tarea 1 — (si falta) Suites integration + e2e completas
Como `stev`, dejarlas TERMINAR, resumen + rojos con error exacto a `ordenes/reportes/minimax-matriz-cd.md`, contenedores huérfanos verificados antes/después.

## Tarea 2 — (si falta) `docs/mapa-de-ficheros.md` — lectura total
Una línea honesta por fichero fuente, ⚠ donde el nombre mienta.

## Tarea 3 — HUÉRFANOS del mapa (tu especialidad: contexto largo + precisión mecánica)
Con el mapa terminado, crúzalo: para cada fichero fuente NO-test, ¿quién lo importa/invoca? (`git grep` del basename y de sus exports principales). Produce `ordenes/reportes/minimax-huerfanos.md`: tabla de candidatos con CERO referencias entrantes (fuera de sí mismos), con la evidencia por fila. NO borres nada — el integrador revisa y ejecuta. Excluye entry-points obvios (main.ts, bin/, *.config.*, deploy/*.mjs referenciados por Dockerfile/compose).

## Tarea 4 — Basura v3 (re-barrido de disco post-todo)
`git status --ignored --porcelain` + `du` de cada ignorado presente: nueva tabla de lo acumulado desde el último barrido (builds regenerados, caches nuevos, .test-state, logs). Borra lo inequívoco (caches/builds regenerables), reporta lo dudoso.

## Tarea 5 — Mantenimiento continuo
`PENDIENTES-DEL-DUEÑO.md` al día; reportes consumidos → `git rm` con evidencia; enlaces sin rutas muertas tras los moves de todos.

Push al cerrar cada tarea + reporte ≤5 líneas.
