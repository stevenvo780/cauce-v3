# Protocolo de trabajo — 4 instancias, cero colisiones

Vigente desde 2026-08-27. Lo lee TODA instancia antes de tocar nada. El plan de fondo está en `plan-reestructura/` y el informe de la auditoría en `docs/bitacora/` (referencia).

## Una sola verdad

- **`main` es la única rama permanente.** El 27-08 se archivaron y borraron 146 ramas, 134 remotas y 75 worktrees. Todo es recuperable de `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle` (`git fetch <bundle> <rama-vieja>:recuperada/<nombre>`) y del tar `/datos/workspaces/zeus/cauce-rescate-worktrees-20260827.tar.gz`. **Prohibido recrear ramas viejas salvo para cherry-pick puntual, y se borran al terminar.**
- Las ramas de trabajo `tarea/<slug>` viven **menos de un día**: se crean, se mergean a main con gate verde, se borran. Una rama con más de 24h es un bug del proceso.

## Aislamiento entre instancias

- Cada instancia trabaja en **SU PROPIO CLON**, nunca en `/datos/workspaces/zeus/cauce-v3` directamente:
  ```sh
  git clone /datos/workspaces/zeus/cauce-v3 /datos/workspaces/zeus/instancias/<instancia>/cauce-v3
  ```
  Al terminar una tarea: push de la rama al repo central (`git push origin tarea/<slug>`; origin del clon = el repo central) y avisar al dueño. **Claude integra**: revisa, mergea a main y borra la rama. Antes de empezar la siguiente tarea: `git pull`.
- **Propiedad por sector** (tabla abajo). Prohibido tocar un fichero fuera de tu sector; si tu tarea lo exige, se anota en el PR y lo aprueba el integrador — no se toca "de paso".

| Sector | Dueño | Revisor |
|---|---|---|
| `apps/console/**` | Gemini | Codex |
| `packages/store/src/**`, `services/gateway/src/**`, maquinaria de release de `ops/scripts/` + sus tests | Codex | Claude |
| Higiene de disco, `docs/`, residuos, verificaciones mecánicas | OpenCode/MiniMax | Claude |
| `_legado/`, `plan-reestructura/`, `ordenes/`, documentación (README/CLAUDE.md/AGENTS.md), integración de merges, FASE 3 (deploy, flota, BD) | Claude + dueño | dueño |
| `packages/store/migrations/**`, `deploy/**`, `/etc/cauce-v3`, `/opt`, contenedores, systemd, base de datos | NADIE hasta FASE 3 | — |

## Reglas de todo commit (sin excepción)

1. Gate antes de push: `pnpm typecheck && pnpm lint` en verde (cuando Codex cierre su tarea 1, también `pnpm test:unit`).
2. `git mv` en commits separados de ediciones de contenido. Commits ≤20 ficheros salvo mv mecánico.
3. Prohibido: comentarios narrativos, fechas o "incidentes" en el código; planes nuevos >100 líneas; declarar "hecho" sin pegar la salida del gate.
4. Mensajes de commit: qué y por qué en ≤5 líneas, sin épica.
5. Ningún `*.patch`, SQL de migraciones, ni nada de la fila NADIE.

## Al terminar cada tarea

Reportar en 5 líneas máximo: rama pusheada, gate (pegado), qué quedó fuera y por qué. Sin ensayos.
