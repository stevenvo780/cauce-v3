# OpenCode/MiniMax — ORDEN ACTIVA (docs al día tras la gran ola + cierre de dudosos)

Protocolo de siempre (pathspec, sin clean/reset/stash, gate como usuario normal). La ola de hoy cambió media estructura: tu ronda es dejar TODA la documentación diciendo la verdad otra vez.

## Tarea 1 — `docs/arquitectura.md` al día
Ya no hay gigantes en store/gateway: `repository.ts` es una fachada de 42 líneas sobre `repository/*.ts`; `app.ts` (408) compone `routes/*`; `terminal/plugin.ts` (326). Actualiza las tablas de flujos (rutas y "qué buscar") verificando CADA ruta nueva con `ls`/`grep` antes de escribirla. Ídem los tamaños honestos del final.

## Tarea 2 — Barrido total de enlaces (tercera pasada)
Misma mecánica que r5: README raíz, README de componentes, AGENTS/CLAUDE/GEMINI.md, plan-reestructura/**, ordenes/**. La ola movió/partió decenas de ficheros.

## Tarea 3 — Índices finales
`docs/bitacora/legado-indice.md` (el _legado se BORRÓ del árbol el 27-08: verifica que el índice liste todo lo retirado, incluida la maquinaria de release), `docs/bitacora/README.md` (entradas nuevas), y la tabla de dudosos de `plan-reestructura/censo-contingentes.md` reducida a los grupos que de verdad esperan al dueño.

## Tarea 3-bis — Correcciones de la revisión ola 2 (tuyas)
1. `ops/harness/healthcheck.mjs` sigue huérfano: la orden anterior escribió mal la ruta (decía ops/scripts/). Muévelo fuera con la re-verificación estándar (y su entrada del digest si aplica).
2. `docs/bitacora/legado-indice.md`: faltan los 13 ficheros que TU ronda 6 retiró — complétalo.
3. `docs/bitacora/README.md`: marca `deploy.md` y `rollback.md` como "runbooks de la maquinaria retirada — obsoletos por completo, no seguir jamás".

## Tarea 4 — La foto final para el dueño
Crea `ordenes/reportes/minimax-foto-final.md`: (a) tabla de TODOS los ficheros fuente >800 líneas que quedan en el repo vivo (ruta, líneas, sector dueño); (b) conteo total de líneas por área vs las cifras de la auditoría de la madrugada (services/packages/apps/ops/tests (lo retirado ya no está en el árbol)); (c) los 3 números del día: cuánto se retiró del árbol (ver docs/bitacora/legado-indice.md), cuánto se partió, cuánto queda >800. Es el "antes y después" medible de la descontaminación.

Gate para commits de .md: no aplica el completo; para cualquier otra cosa: el global. Push al cerrar + reporte ≤5 líneas.
