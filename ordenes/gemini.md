# Gemini — ORDEN ACTIVA (dos sectores: consola + canales)

Protocolo `ordenes/00-PROTOCOLO.md` (pathspec, sin clean/reset/stash, gate global `pnpm typecheck && pnpm lint && pnpm test:unit` como usuario normal). Usa subagentes en paralelo (máx. 4, ficheros disjuntos, solo tú commiteas). Estándar de mudanza: byte-puro, reindentado, sin exports nuevos (`ordenes/reportes/claude-revision-46-commits.md`).

## Parte A — Consola: deuda fina de las particiones (corta, primero)
0. **AUDITORÍA a1425e5 (herencia de Terra, PRIORIDAD)**: ese commit cambió PRODUCTO e invirtió aserciones sin que hubiera un test rojo que lo forzara y sin el reporte obligatorio (`claude-revision-ola2.md`, área terra-tests). Examínalo cambio a cambio: lo justificado se queda CON reporte escrito en `ordenes/reportes/gemini-veredicto-a1425e5.md`; lo no justificado se revierte.
1. **Comentarios-invariante**: las particiones borraron 190 comentarios; restaura SOLO los que documentan invariantes medidos de concurrencia/seguridad/orden obligatorio (~15-30, no 190), reescritos en una línea sobria. AÑADE los ~101 comentarios-invariante que 832888d borró al partir DirectivaModal (mismos criterios) y ten en cuenta que la ola sumó 18 exports huérfanos nuevos al punto 4. Originales: `git show 1ca3312^:apps/console/src/features/terminal/pty-session.ts`, `git show 91bb5d7^:...OperatorWorkspace.tsx` y los CSS previos.
2. **Punteros muertos**: `features/config/campos-inertes.ts` y `SpaceWizard.tsx` citan `repository.ts:NNNN` inexistentes (repository = fachada de 42 líneas). Actualiza cada uno a su módulo real verificando la línea destino.
3. **Dedup @import**: el resolutor recursivo de `@import` está copiado 11 veces en tests, con 2 nombres y sin guardia anti-ciclos → uno solo en `src/test/css-imports.ts`, migra los 11, borra copias.
4. **Exports muertos** en `apps/console/src` + `PtyEntry` de vuelta a privado si nada externo lo usa.

## Parte B — Canales: carpintería de tus dos servicios (la grande)
Paraleliza por fichero (un subagente cada uno):
- `services/terminal-relay/src/gateway-client.ts` (1.244) — canje de tickets vs authz vs presencia vs HTTP.
- `services/terminal-relay/src/sessions.ts` (1.235) — ciclo de vida vs flujo de bytes vs cierre/reporting.
- `services/terminal-relay/src/{agent-leg,browser-leg}.ts` si superan 800.
- `services/telegram-bridge/src/poller.ts` y cualquier >800 del bridge (mide con `wc -l` primero) — OJO: canal REAL del dueño en producción; máxima disciplina.
Tests después: `pnpm test:terminal-pty` y `pnpm test:services` verdes, pegados en el reporte.

Push al cerrar cada parte + reporte ≤5 líneas.
