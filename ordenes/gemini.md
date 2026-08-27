# Órdenes — Gemini (sector: `apps/console/**`)

Lee `ordenes/00-PROTOCOLO.md` primero. Trabaja DIRECTO en `main` del checkout principal: commits pequeños con gate, `git add` solo de tus rutas, prohibido crear ramas. Detalle de fondo: `plan-reestructura/14-carpinteria-consola.md`.

## Tarea 1 — Verificar tu propia limpieza (PRIMERO)
Tu limpieza de comentarios ya está en main (commit `2a22107`, 300 ficheros, −8.830 líneas), pero su mensaje admite que también tocó lógica ("error handling", "session termination", vitest config). Audítate:
1. `git show 2a22107 -- <fichero>` sobre los ficheros NO-test que cambiaron más que comentarios: lista cada cambio de comportamiento que metiste y verifica que fue intencional y correcto.
2. Confirma que NO tocaste: ficheros `.patch`, `packages/store/migrations/`, `deploy/`, `ops/guardias/`. Si tocaste alguno, repáralo a su estado previo.
3. Reporta la lista de cambios de comportamiento encontrados (no los "arregles" en silencio).

## Tarea 2 — Muertos confirmados
- Borra `apps/console/src/features/topology/TopologyPage.tsx` (inalcanzable por diseño: su alias de ruta se resuelve antes que la tabla; el propio fichero lo admite). OJO: `TenantCards.tsx` y `AclEdgeList.tsx` SÍ se usan en `LiveFleetPage` — se quedan.
- `apps/console/src/features/_grafo/` (SQL exploratorio sin conectar): muévelo a `docs/bitacora/` con `git mv`.

## Tarea 3 — Renombres honestos
`features/activity`, `features/licenses`, `features/quotas` ya no exportan páginas — exportan componentes que consumen `LiveFleetPage` y `AccountsPage`. Renombra o reubica para que el nombre diga lo que son. Solo `git mv` + imports, commit separado.

## Tarea 4 — Partir `styles.css`
`src/styles.css` (~919 líneas tras tu limpieza; fue reescrito 37 veces) → partir por área (base/layout, componentes, vistas) con imports. Cero cambios de valores: el CSS computado debe quedar idéntico.

## Prohibido en tu sector
- Tocar la lógica del editor (`FicherosTab`, `ficheros.ts`, `DirectivaModal`): funciona y está bien hecho; se despliega en FASE 3.
- El entorno de test (el fix de AbortSignal es de Codex — no lo dupliques).
- Rediseño visual o de UX.

## Gate por commit
`pnpm --filter @cauce/console typecheck && pnpm --filter @cauce/console lint`. Los tests de consola tienen 533 fallos preexistentes por un bug de entorno (AbortSignal, lo arregla Codex): anota el número de fallos antes/después de cada tarea tuya — **no debe subir**.
