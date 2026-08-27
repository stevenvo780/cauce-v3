# OpenCode/MiniMax — ORDEN ACTIVA (CI al día + archivo de planes ejecutados)

Protocolo de siempre (pathspec, sin clean/reset/stash). Doctrina: lo muerto se borra con `git rm` — git es el archivo.

## Tarea 1 — CI con el gate completo
`.github/workflows/ci.yml`: añade `pnpm test:unit` (el gate global ya lo incluye; consola está 107/107). Cuida el tiempo: si supera ~15 min en Actions, separa `test:unit` en un job paralelo al de typecheck+lint.

## Tarea 2 — Archivar los planes EJECUTADOS (FASE 1 está completa)
`git mv` a `docs/bitacora/plan-ejecutado/`: `plan-reestructura/{11-higiene-raiz-y-worktrees,12-cuarentena-legado,13-carpinteria-backend,14-carpinteria-consola,15-documentacion-real}.md`. Se QUEDAN: `00-LEEME.md`, `21-*`, `31/32/33-*`, `fase3/` y `censo-contingentes.md` (tiene la tabla de dudosos del dueño). Actualiza las referencias que apunten a los movidos (barrido de enlaces estándar).

## Tarea 3 — `plan-reestructura/00-LEEME.md` con el estado real
Añade al inicio una sección corta "Estado a 27-08": FASE 1 (orden/legibilidad) COMPLETADA — ver bitácora/plan-ejecutado; FASE 2 (correcciones) en cierre por Codex/Gemini; FASE 3 lista y esperando la ventana del dueño (dossier + deploy.sh + smoke calibrado). Actualiza la tabla de reparto a los sectores vigentes del protocolo.

## Tarea 4 — Índices de bitácora (si tu 3-bis quedó a medias)
`docs/bitacora/README.md`: entrada para `ordenes-ejecutadas/` y `plan-ejecutado/`, y las marcas de `deploy.md`/`rollback.md` como obsoletos. `legado-indice.md`: completo con TODO lo retirado (incluidos tus 13 de la ronda 6 y lo que Codex retiró después).

## Tarea 5 — Barrido de enlaces final
Tras tus moves: README raíz, AGENTS/CLAUDE/GEMINI.md, arquitectura.md, ordenes/** — cero rutas muertas.

Push al cerrar + reporte ≤5 líneas.
