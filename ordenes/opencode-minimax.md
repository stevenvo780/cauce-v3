# OpenCode/MiniMax — ORDEN ACTIVA (tareas LARGAS: suites pesadas + lectura total del repo)

Protocolo de siempre. Doctrina actualizada: **ya no existe `docs/bitacora`** (borrada — git es el archivo); nada se "archiva": lo consumido se borra con `git rm` y evidencia en el commit. Nuevo gate determinista: `pnpm lint` ahora incluye `lint:calidad` (trinquete: ningún fichero nuevo >800 líneas, ninguna fecha nueva en comentarios).

## Tarea 1 — Correr las DOS suites que faltan de la matriz (LARGAS, déjalas terminar)
Como usuario normal (`stev`), una tras otra, capturando salida completa:
1. `pnpm test:integration` (testcontainers, tarda)
2. `pnpm test:e2e` (levanta PostgreSQL real + gateway + dispatcher; tarda más)
Al terminar cada una: pega el resumen (ficheros/tests, verdes/rojos, duración) en `ordenes/reportes/minimax-matriz-cd.md`. Si hay ROJOS: NO arregles nada — lista cada uno con su error exacto y su fichero; el integrador los enruta. Verifica después que no quedaron contenedores huérfanos (`docker ps` antes/después pegado).

## Tarea 2 — LECTURA TOTAL del repo → `docs/mapa-de-ficheros.md` (contexto largo, tu especialidad)
Recorre TODOS los ficheros fuente trackeados (`git ls-files` filtrado a .ts/.tsx/.mjs/.py/.sh, sin tests) — unos ~400. LEE cada uno (no adivines por el nombre) y escribe UNA línea por fichero: `ruta — qué hace de verdad — sector dueño`. Agrupado por directorio, con subtotales de líneas. Regla de honestidad: si un fichero no hace lo que su nombre dice, márcalo con ⚠ y una palabra de por qué. Este mapa es para humanos e IAs nuevas: la verdad del árbol en un solo documento. (Los tests: solo una línea por SUITE, no por fichero.)

## Tarea 3 — Mantenimiento de lo tuyo ya entregado
1. `PENDIENTES-DEL-DUEÑO.md`: mantenlo al día si algo se resuelve (es LA página del dueño).
2. Los reportes de `ordenes/reportes/` ya consumidos (verifica con git log que sus correcciones aterrizaron): `git rm` con evidencia. Se quedan los insumos activos (censo de comentarios, matriz, revisiones con intake pendiente, vistas-sin-uso).
3. Foto final v2 cuando Codex y Gemini cierren (pregunta al dueño): tabla >800 contra el baseline de `scripts/calidad-base.json` — el objetivo es que el trinquete quede en cero.

Push al cerrar cada tarea + reporte ≤5 líneas.
