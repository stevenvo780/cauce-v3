# Órdenes — Gemini · Ronda 3 (sector: `apps/console/**`)

Protocolo: `ordenes/00-PROTOCOLO.md`. Directo a main, `git add` solo tus rutas, `git diff --cached` antes de commitear, push al cerrar. Subagentes: ficheros disjuntos, máx. 4, solo tú commiteas.

## Tarea 1 — Rematar los 13 tests rojos de consola (PRIORIDAD: desbloquea el gate global)
El fix de AbortSignal bajó los fallos de 533 → 13 (6 ficheros, 1.353 verdes). Corre `pnpm --filter @cauce/console test`, toma los 6 ficheros que fallan y arregla las causas restantes. REGLA DURA: **prohibido debilitar aserciones o poner skip para forzar verde** — si un test revela un bug real del producto, NO toques el producto: repórtalo en `ordenes/reportes/gemini-bugs-reales.md` con archivo:línea y deja el test rojo. El objetivo es 107/107 ficheros verdes o una lista corta de bugs reales documentados. Cuando quede verde, avisa: `pnpm test:unit` entra al gate global de todas las instancias.

## Tarea 2 — Partir `pty-session.ts` (1.029 líneas)
`src/features/terminal/pty-session.ts` mezcla: máquina de estados de conexión, protocolo de frames, reconexión/backoff, rate-limit de input y el puente al worker. Partir por responsabilidad, cero cambios de comportamiento, ningún resultante >500 líneas. Los tests existentes pasan sin editar (salvo imports).

## Tarea 3 — Barrido de CSS muerto
Tras tus particiones de `styles.css` y `live.css`: pasa un detector de selectores no usados (grep de clases contra los .tsx) sobre TODOS los .css de `src/`, y borra los selectores que no casan con ningún componente. Commit separado por fichero css, con el conteo antes/después en el mensaje. Ante la duda (clases construidas dinámicamente), conservar y anotar.

Al terminar TODO: `git push origin main` y reporte de ≤5 líneas.
