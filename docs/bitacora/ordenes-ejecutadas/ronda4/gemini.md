# Órdenes — Gemini · Ronda 4 (sector: `apps/console/**`)

Empezar al cerrar la ronda 3. Protocolo: `ordenes/00-PROTOCOLO.md` (directo a main, **commit con pathspec**, gate, push al cerrar; subagentes disjuntos máx. 4).

## Tarea 1 — Partir `DirectivaModal.tsx` (577 líneas) y revisar `features/live/`
El modal de 3 capas mezcla presentación, estado y llamadas. Partir por capa/responsabilidad (mismo método que OperatorWorkspace), cero cambios de comportamiento. De paso: si algún otro fichero de `features/live/` supera 500 líneas, pártelo igual.

## Tarea 2 — Barrido de exports muertos
Sobre TODO `apps/console/src`: detecta símbolos exportados que ningún otro fichero importa (y que no sean entry points de Vite ni usados por tests). Borra los muertos con evidencia en el mensaje de commit (`export X en A:línea — 0 importadores`). Ante APIs públicas dudosas, conservar y listar en el reporte.

## Tarea 3 — (CONDICIONAL: solo si el dueño ya marcó su decisión sobre `ordenes/reportes/gemini-vistas-sin-uso.md`)
Ejecutar la decisión vista por vista: conservar / mover a `_legado/consola/` con `git mv`. Si no hay decisión todavía, saltar y decirlo en el reporte.

Al terminar: gate de consola + conteo de tests igual o mejor + `git push origin main` + reporte ≤5 líneas.
