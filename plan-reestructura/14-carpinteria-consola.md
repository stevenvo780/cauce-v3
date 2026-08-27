# 14 — Carpintería de la consola

**Fase:** 1 · **Tamaño:** mediano · **Ejecutor:** Codex · **Revisor:** Gemini
**Rama:** `reestructura/14-consola` · **Depende de:** nada (sector disjunto de 13)

## Objetivo
La consola (29.6K líneas src + 22.9K test + 6.6K css) está mejor de lo que parecía — la auditoría confirmó que el editor de ficheros y las vistas están conectados de verdad. La carpintería aquí es quitar lo muerto, terminar la limpieza de prosa y ordenar nombres, sin rediseñar nada.

## Tareas

1. **Integrar la limpieza de comentarios de Gemini.** Está sin commitear (~300 ficheros, −8.830 líneas). Primero: rama `limpieza/comentarios-20260827`, commit, gate. Revisar en el diff que NO se tocaron: ficheros `.patch`, SQL, YAML de deploy, `ops/guardias/`. Si se tocaron, revertir esos ficheros puntuales.
2. **Borrar componentes muertos confirmados:**
   - `src/features/topology/TopologyPage.tsx` — inalcanzable por diseño (su alias de ruta se resuelve antes que la tabla; el propio fichero lo admite). Sus hijos `TenantCards`/`AclEdgeList` SÍ se usan en LiveFleetPage: conservar.
   - `src/features/_grafo/` — SQL exploratorio sin conectar (untracked): mover a `docs/bitacora/` o borrar.
3. **Renombrar directorios desalineados** tras la consolidación de vistas (activity/licenses/quotas ya no exportan páginas, exportan componentes reutilizados): renombrar a lo que son o mover los componentes junto a su único consumidor. `git mv` puro, commit separado.
4. **Vistas cuyo endpoint no recibió NI UNA petición humana en 3,5 días** (audit, jobs oculta, chains, egress/notifications): no borrar todavía — añadir cada una a `_legado/README.md` como candidata, decisión del dueño en FASE 2.
5. **CSS:** `styles.css` (1.289 líneas en HEAD) fue reescrito 37 veces y existe en 10 versiones en worktrees. Tras integrar la limpieza, partirlo por área (layout base / componentes / vistas) en commits mecánicos.

## No tocar
- La lógica del editor (`FicherosTab`, `ficheros.ts`, `DirectivaModal`) — funciona y está bien hecha; solo se toca en FASE 3 cuando se despliegue.
- `pty-session.ts` y `features/terminal/` — se toca en 21 (test env) y 32 (flota).
- Nada de rediseño visual ni de UX en esta fase.

## Gate de aceptación
- `pnpm --filter @cauce/console typecheck && lint` verdes.
- Los tests de consola: no peor que la línea base conocida (533 fallos preexistentes por AbortSignal — se arreglan en 21, no aquí). Anotar el número exacto antes/después en el PR.
- `git grep TopologyPage` → solo en historia.
