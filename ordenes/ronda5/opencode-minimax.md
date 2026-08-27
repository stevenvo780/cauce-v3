# Órdenes — OpenCode/MiniMax · Ronda 5 (índices y verificación post-mudanzas)

Empezar al cerrar la ronda 4. Protocolo: `ordenes/00-PROTOCOLO.md` (directo a main, **commit con pathspec**, push al cerrar). Solo .md/config, nada de código de producto.

## Tarea 1 — Re-verificar TODOS los enlaces/rutas de la documentación
Hoy se movieron decenas de ficheros (censo, particiones, extracciones). Repite tu verificación de ronda 3 sobre: `README.md`, `docs/arquitectura.md` (¡sus tablas citan rutas que pueden haber cambiado: pty-session partido, repository/ modular!), los README de componentes, `plan-reestructura/**`, `ordenes/**`, `_legado/README.md`. Corrige lo obvio, reporta lo dudoso en `ordenes/reportes/minimax-enlaces-r5.md`.

## Tarea 2 — Índice de `_legado/`
`_legado/README.md` creció a trozos. Reescríbelo ordenado: una sección por origen (services, release-machinery, contingentes del censo, tests) con tabla fichero/familia → evidencia de por qué está ahí (una línea) → dónde está el detalle. Mantén la sección "Cómo recuperar cualquier cosa".

## Tarea 3 — Censo de TODO/FIXME/HACK
`grep -rn "TODO\|FIXME\|HACK\|XXX" --include="*.ts" --include="*.tsx" --include="*.py" --include="*.sh"` sobre el árbol vivo (fuera de `_legado/`, tests incluidos): tabla en `ordenes/reportes/minimax-todos.md` con fichero:línea → texto → tu clasificación (deuda real / obsoleto / ruido). No edites código.

## Tarea 4 — Consolidación de `.gitignore`
Hay ignores repartidos (raíz, ops/, paquetes). Audita duplicados, reglas muertas (rutas que ya no existen) y huecos (¿`_legado/**/node_modules`? ¿artefactos nuevos?). Propón el diff en el reporte y aplica solo lo inequívoco.

## Tarea 5 — (CONDICIONAL: si el dueño marcó decisiones en la tabla de 45 dudosos de `plan-reestructura/censo-contingentes.md`)
Ejecutarlas igual que la ronda 4 (mv/rm según decisión, gate de generadores incluido). Si no hay decisiones, saltar.

Al terminar: `git push origin main` + reporte ≤5 líneas.
