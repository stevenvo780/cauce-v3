# 11 — Higiene de raíz, worktrees y residuos

**Fase:** 1 · **Tamaño:** mediano, mecánico · **Ejecutor:** Gemini o MiniMax · **Revisor:** Codex
**Rama:** ninguna — directo a `main` · **Depende de:** nada (puede empezar ya)

## Objetivo
Que la raíz del repo y el disco dejen de mentir: hoy la raíz mezcla producto con informes sueltos, y hay 75 árboles de trabajo (2,6 GB), 620 MB de copias en /opt y contenedores de test huérfanos. Todo esto contamina el contexto de cada agente que abre el repo.

## Alcance
Raíz del repo, `docs/`, `.git/worktrees`, `/datos/workspaces/zeus/wt*`, `.test-state/`, `dist/`, contenedores de test.

## Tareas

### A. Raíz del repo
1. Crear `docs/bitacora/` y mover ahí (con `git mv`) todo doc con fecha en el nombre o carácter de sesión/handoff: `PLAN-DIRECTIVE-CONTENT-LECTURA.md`, y de `docs/`: `HANDOFF-*`, `pendientes-*`, `consola-e2e-*`, `queues-contadores-*`, `COHERENCIA-*`, `tmux-sesion-real.md`, `sesion-compartida-tmux.md`.
2. Los 3 informes sin versionar de la raíz (`ARQUITECTURA_DETALLADA.md`, `INFORME_ARCHIVOS_INCONEXOS_Y_BASURA.md`, `INFORME_COMENTARIOS_HISTORICOS_Y_LIMPIEZA.md`): moverlos a `docs/bitacora/` y commitearlos (hoy no están en git; son referencia útil, no verdad canónica).
3. `dist/` de la raíz es un mosaico de builds de julio–agosto que no corresponde a HEAD: borrarlo (`pnpm build` lo regenera; verificar que `.gitignore` lo cubre).
4. `ops-evidence/`: revisar contenido; si es evidencia vieja de agosto, mover a `docs/bitacora/` o borrar.

### B. Worktrees (CUIDADO: primero rescatar, después podar)
1. **Rescate previo** — hay ~6.460 líneas que no están en ningún commit. Antes de podar nada:
   - En `/datos/workspaces/zeus/wt-editor` y `wt-backend-directiva`: commitear TODO lo sucio y sin trackear en una rama `rescate/editor-directiva-20260827` (3.263 líneas de un editor alternativo; quizá se descarte, pero que quede en git).
   - Ídem en `wt-fuente-unica`, `wt-topology`, `cauce-v3-sesion` → rama `rescate/varios-20260827`.
   - En el clon `/datos/workspaces/cauce-v3`: commitear su deriva local (+778/−246) en una rama y pushearla al repo principal como `rescate/clon-hermano`.
2. `git worktree prune` (elimina los 65 metadatos huérfanos que apuntan a /tmp inexistentes).
3. Borrar los directorios de worktree ya limpios y mergeados o rescatados (61 están limpios). Conservar solo los que el dueño confirme activos.
4. Los 13 árboles `/opt/cauce-v3-release-*` (620 MB, residuo del bucle de deploy del 26-ago): **no borrar en esta fase** (pueden servir de referencia en FASE 3, fichero 31). Solo inventariarlos en el PR.

### C. Residuos de test
1. `.test-state/`: 198 subdirectorios, 72 vacíos. Borrar los vacíos y los de fechas viejas; verificar que los tests de adapter-sdk que lo usan como fixture siguen en verde.
2. Contenedores de test huérfanos: `hopeful_hopper`, `practical_heyrovsky`, `frosty_meninsky` (postgres de Testcontainers de días distintos) y `cauce-test-zeus` — pedir confirmación al dueño y `docker rm -f`. Causa raíz: `scripts/test.sh:14` pone `TESTCONTAINERS_RYUK_DISABLED=true` sin cleanup compensatorio → añadir trap de limpieza o quitar esa variable.
3. Stashes: hay 3 (`git stash list`). Convertir cada uno en rama `rescate/stash-N` y vaciar la lista.

## No tocar
Todo lo de la lista global de 00-LEEME. Además: no tocar código fuente (eso es 13/14), no tocar `ops/` salvo `ops-evidence`.

## Gate de aceptación
- `pnpm typecheck && pnpm lint` en verde.
- `git worktree list` sin huérfanos; raíz del repo con solo ficheros de producto.
- Ninguna línea de las ramas `rescate/*` perdida (verificable con `git log --all`).
