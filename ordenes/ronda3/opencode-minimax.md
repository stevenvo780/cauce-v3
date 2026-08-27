# Órdenes — OpenCode/MiniMax · Ronda 3 (ejecución de tus propios hallazgos + verificación de enlaces)

Protocolo: `ordenes/00-PROTOCOLO.md`. Directo a main, `git add` solo tus rutas, `git diff --cached` antes de commitear, push al cerrar. Solo `.md` y ficheros de config no-producto.

## Tarea 1 — Aplicar las correcciones que tu propio reporte identificó (aprobadas por el integrador)
De `ordenes/reportes/minimax-runbooks.md`, ejecuta las 6 ediciones quirúrgicas (solo esas líneas, nada más):
1. `ops/runbooks/authentication.md` L128–129: elimina/ajusta la referencia a `relay_provider_module` del relay-worker (está en `_legado`).
2. `ops/runbooks/e2e-integration.md` L27: quita `relay-worker` y `shadow-router` de la lista de binarios y anota que `test-compose-authentic` queda roto hasta `plan-reestructura/31`.
3. `ops/runbooks/fleet-watchdog.md` L15: la lista de aliases esperados son 15 (falta `zeus`).
4. `ops/runbooks/telegram-cutover.md` L15: quita `services/relay-worker` de la lista de sectores.
5. `ops/runbooks/alias-cutover.md`: añade UNA línea de caveat al inicio: "La dual-stack V2/V3 ya no es operativa; esto aplica solo como referencia de rollback (`_legado/rollback-bridge`)."
6. `ops/runbooks/ha.md`: añade UNA línea junto a la mención de `test-compose-authentic`: "(QA rota hasta plan-reestructura/31)".
Los ADR quedan SIN CAMBIOS (tu reporte lo confirmó; decisión ratificada).

## Tarea 2 — Verificador de enlaces y rutas de toda la documentación
La reestructura movió muchas cosas; los docs pueden apuntar a rutas muertas. Recorre TODOS los enlaces relativos y rutas citadas en: `README.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/arquitectura.md`, `docs/*.md`, los README de services/packages/apps/ops/pty-agent, `plan-reestructura/*.md`, `ordenes/**/*.md`, `_legado/README.md`. Para cada ruta citada: ¿existe? Si no existe: corrígela si el destino es obvio (se movió), o márcala en el reporte si no lo es. Reporte: `ordenes/reportes/minimax-enlaces.md` (tabla: fichero → ruta rota → corregida a / pendiente).

## Tarea 3 — Verificación de los docs sueltos de `docs/`
Misma mecánica que hiciste con los runbooks, para: `docs/consola-roles-con-nombre.md`, `docs/terminal-pty.md`, `docs/directiva-ficheros-del-agente.md`, `docs/threat-model.md`. Veredicto vigente/desactualizado-en-X/a-bitácora con evidencia → `ordenes/reportes/minimax-docs-sueltos.md`. NO los muevas; el integrador decide.

## Tarea 4 — Inventario de residuos del host (si no lo entregaste en ronda 1)
Si `ordenes/reportes/minimax-residuos-host.md` no existe, créalo: tabla de (a) contenedores docker de test huérfanos con fechas, (b) los 13 árboles `/opt/cauce-v3-release-*` con tamaño, (c) imágenes `rc-*` y `*-legacy` del registry local con fechas, (d) el clon muerto `/datos/workspaces/cauce-v3`. Solo reporte con el comando de borrado propuesto por fila — el dueño aprueba, nadie borra.

Al terminar: `git push origin main` y reporte de ≤5 líneas.
