# Protocolo de trabajo — 4 instancias, cero colisiones

Vigente desde 2026-08-27. Lo lee TODA instancia antes de tocar nada. El plan de fondo está en `plan-reestructura/` y el informe de la auditoría en `docs/bitacora/` (referencia).

## Una sola verdad: `main`, sin ramas

- **Todo el trabajo va DIRECTO a `main`. Prohibido crear ramas.** Decisión del dueño (27-08): en este repo las ramas fueron el cementerio — el 40% del trabajo se pudrió fuera de main. Si un experimento da miedo en main, se consulta al dueño antes; no se abre una rama "por si acaso".
- El 27-08 se archivaron y borraron 146 ramas, 134 remotas y 75 worktrees. Todo es recuperable de `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle` (`git fetch <bundle> <rama-vieja>:FETCH_HEAD` + cherry-pick) y del tar `/datos/workspaces/zeus/cauce-rescate-worktrees-20260827.tar.gz`. Recrear una rama vieja solo para un cherry-pick puntual, y se borra en el momento.

## Convivir en main sin pisarse (esto sustituye a las ramas)

Todas las instancias comparten el checkout `/datos/workspaces/zeus/cauce-v3`. Las reglas que evitan el choque:

1. **Propiedad por sector** (tabla abajo) — es LA protección principal. Prohibido tocar un fichero fuera de tu sector; si tu tarea lo exige, se pide al integrador — no se toca "de paso".
2. **`git add` solo por rutas propias.** PROHIBIDO `git add -A`, `git add .` y `git commit -a`: barren el trabajo a medias de otra instancia. Se añade fichero a fichero (o por directorio propio).
3. **Commit pequeño e inmediato** tras el gate: nada de acumular horas de cambios sin commitear en el árbol compartido.
4. **Gate ANTES de cada commit** que toque código: `main` nunca queda en rojo. Commits que solo tocan `.md` no requieren gate completo.
5. Si `git commit` falla por lock o el árbol cambió bajo tus pies: espera y reintenta; nunca hagas `reset`/`checkout` sobre ficheros que no son tuyos.

| Sector | Dueño | Revisor |
|---|---|---|
| `apps/console/**` | Gemini | Codex |
| `packages/store/src/**`, `services/gateway/src/**`, maquinaria de release de `ops/scripts/` + sus tests | Codex | Claude |
| Higiene de disco, `docs/`, residuos, verificaciones mecánicas | OpenCode/MiniMax | Claude |
| `_legado/`, `plan-reestructura/`, `ordenes/`, documentación (README/CLAUDE.md/AGENTS.md), integración de merges, FASE 3 (deploy, flota, BD) | Claude + dueño | dueño |
| `packages/store/migrations/**`, `deploy/**`, `/etc/cauce-v3`, `/opt`, contenedores, systemd, base de datos | NADIE hasta FASE 3 | — |

## Reglas de todo commit (sin excepción)

1. Gate antes de commit: `pnpm typecheck && pnpm lint` en verde (cuando Codex cierre su tarea 2, también `pnpm test:unit`).
2. `git mv` en commits separados de ediciones de contenido. Commits ≤20 ficheros salvo mv mecánico.
3. Prohibido: comentarios narrativos, fechas o "incidentes" en el código; planes nuevos >100 líneas; declarar "hecho" sin pegar la salida del gate.
4. Mensajes de commit: qué y por qué en ≤5 líneas, sin épica.
5. Ningún `*.patch`, SQL de migraciones, ni nada de la fila NADIE.

## Subagentes: sí, con disciplina

Todos los harness de la flota los soportan — **úsalos** para agilizar lo paralelizable (barridos, renombres masivos, verificaciones, extracciones módulo a módulo). Reglas, aprendidas de la quema de agosto:

1. **Ficheros disjuntos por subagente** — un fichero tiene UN dueño por ronda. Reparte por fichero/directorio ANTES de lanzar, por escrito en el prompt de cada uno.
2. **Tope de concurrencia: 4** subagentes, profundidad 1 (un subagente no lanza subagentes).
3. **Solo el proceso principal commitea.** Los subagentes editan y reportan; el padre revisa, pasa el gate y hace el commit. Nunca dos procesos commiteando a la vez.
4. Los subagentes heredan TODO este protocolo: sector de su instancia, NO-TOCAR, sin ramas, sin `add -A`, sin comentarios narrativos.
5. Si un subagente reporta "hecho" sin evidencia (salida de comando, diff), su trabajo se verifica antes de commitear — la auditoría midió subagentes declarando "1091 tests pasan" cuando fallaban 53 ficheros.

## Al terminar cada tarea

Reportar en 5 líneas máximo: commits hechos (hashes), gate (pegado), qué quedó fuera y por qué. Sin ensayos.
