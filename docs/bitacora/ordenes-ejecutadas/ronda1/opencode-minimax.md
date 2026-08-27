# Órdenes — OpenCode/MiniMax (sector: higiene de disco, docs y verificaciones mecánicas)

Lee `ordenes/00-PROTOCOLO.md` primero. Tareas de rutina, mecánicas y verificables. Trabaja DIRECTO en `main` del checkout principal (commits pequeños, `git add` solo de tus rutas, prohibido crear ramas); lo de disco es directo. NO toques código fuente (.ts/.tsx/.py de producto) — si una tarea parece pedirlo, repórtalo y para. Usa subagentes para lo paralelizable (sección "Subagentes" del protocolo: ficheros disjuntos, tope 4, solo tú commiteas).

## Tarea 1 — Consolidar `basura/` en `docs/bitacora/`
`git mv basura/ARQUITECTURA_DETALLADA.md basura/INFORME_*.md basura/PLAN-DIRECTIVE-CONTENT-LECTURA.md docs/bitacora/ && rmdir basura`. Revisa después `docs/`: lo fechado o de sesión que quede suelto también va a `docs/bitacora/` (los ADR, threat-model, terminal-pty.md y directiva-ficheros-del-agente.md se quedan).

## Tarea 2 — Residuos de test en el repo
1. `.test-state/`: ~198 subdirectorios, 72 vacíos (está gitignored). Borra los vacíos y los anteriores al 25-ago. Después corre `pnpm --filter @cauce/adapter-sdk test` y pega el resultado (674 tests; deben seguir verdes — algunos usan .test-state como fixture).
2. `ops-evidence/` y `dist/` de la raíz: son restos de builds/evidencia viejos que no corresponden a HEAD. Bórralos y verifica que `.gitignore` los cubre.
3. `ops/artifacts/`: inventaria qué hay (fechas y tamaños) y repórtalo — no borres sin confirmación del dueño.

## Tarea 3 — Inventario de residuos FUERA del repo (solo reporte, el dueño borra)
Reporta en una tabla, sin ejecutar borrados:
1. Contenedores docker huérfanos de test: `hopeful_hopper`, `practical_heyrovsky`, `frosty_meninsky`, `cauce-test-zeus`, `cauce-v3-restore-drill-20260825`, `cauce-inspect-migration024` (verifica con `docker ps -a` cuáles siguen).
2. Los 13 árboles `/opt/cauce-v3-release-*` (620 MB, residuo del bucle de deploy del 26-ago).
3. El clon muerto `/datos/workspaces/cauce-v3` (su deriva ya está rescatada en el bundle como `rescate/clon-hermano-20260827`).
4. Imágenes docker `rc-*` y `*-legacy` del registry local `127.0.0.1:5000` con fechas.

## Tarea 4 — Verificación de la cuarentena
Con `git grep` sobre el árbol vivo (excluyendo `_legado/` y `docs/`): busca referencias colgantes a `shadow-router`, `relay-worker`, `rollback-bridge`, `produce-rollback-bridge-evidence`. Clasifica cada hit: (a) string de compose/observabilidad esperado (documentado en `_legado/README.md`), o (b) referencia rota real → repórtala. No arregles nada tú.

## Tarea 5 — Poda del origin de GitHub (necesita al dueño)
El remoto `origin` (github.com/stevenvo780/cauce-v3) aún tiene ramas viejas. Prepara y muéstrale al dueño el comando exacto para borrarlas dejando solo `main` (`git push origin --delete ...` con la lista real de `git ls-remote --heads origin`), y que él lo apruebe antes de ejecutar.

## Gate
Para commits al repo: `pnpm typecheck && pnpm lint` en verde. Para reportes: tabla corta con comandos usados y salida. Máximo 5 líneas de prosa por reporte.
