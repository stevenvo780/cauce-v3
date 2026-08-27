# Órdenes — OpenCode/MiniMax · Ronda 6 (descontaminación: los inequívocos restantes)

Empezar al cerrar la ronda 5. Protocolo de siempre: directo a main, **commit con pathspec**, gate (`pnpm typecheck && pnpm lint` como usuario normal, nunca root) + generadores (`python3 ops/scripts/generate-container-units.py --rootless --output /tmp/gen-test && python3 ops/scripts/validate-manifests.py` rc=0), push al cerrar. Para CADA move: re-verifica antes con `git grep <basename>` fuera de `_legado/`/bitácora + systemd instalado (la ronda 4 lo hiciste perfecto — mismo estándar; recuerda el caso `guard-check.sh`).

## Tarea 1 — Schemas sin consumidor (censo, dudosos que la evidencia ya resolvió)
`git mv` a `_legado/contingentes/ops/schemas/` los 6 con CERO consumidor localizable (evidencia en `plan-reestructura/censo-contingentes.md`): `dlq-no-replay-resolution`, `dlq-reconciliation`, `fleet-snapshot`, `gate-snapshot`, `physical-fleet-snapshot`, `telegram-manual-replay` (.schema.json). Los 7 schemas cuyo único consumidor es la maquinaria de release NO los toques — se los lleva Codex con la maquinaria (su ronda 3).

## Tarea 2 — Huérfanos de ops/harness y ops/tests
1. `ops/harness/Dockerfile` + `.dockerignore` (nadie lo construye; todo el repo usa `deploy/Dockerfile`) y `ops/scripts/healthcheck.mjs` (solo aparecía en ese Dockerfile huérfano) → `_legado/contingentes/`. `ops/harness/CONTRACT.md` → `docs/bitacora/`.
2. Tests de `ops/tests/` que NINGÚN runner invoca (re-verifica contra `ops/scripts/validate.sh`, `package.json` y `ops/Makefile` antes de cada uno): `aplicar-separacion-config.test.mjs`, `test_censo_config_por_alias.py`, `test_generate_telegram_config.py`, `test_telegram_cutover_preflight.py`, `test_dlq_cli.py` → `_legado/tests/`. Si alguno SÍ aparece en un runner, no lo muevas y repórtalo.
3. Sus sujetos de `ops/scripts/` (`aplicar-separacion-config.sh`, `censo-config-por-alias.py`, `diff-consola-visible.py`, `preflight.sh`) → `_legado/contingentes/ops/scripts/` con la misma re-verificación. La familia DLQ (`dlq_cli.py` + 5 wrappers) **NO** — son herramientas manuales de emergencia del operador; quedan para decisión del dueño.

## Tarea 3 — Ejecutar tu propio reporte de docs sueltos
Si `docs/bitacora/reportes/minimax-docs-sueltos.md` marcó algo "a-bitácora" o "desactualizado en X": ejecuta los moves y las correcciones de una línea. Si no existe el reporte, hazlo primero (mecánica de la ronda 3).

## Tarea 4 — La tabla del dueño, corta y final
Reescribe la sección "dudosos" de `plan-reestructura/censo-contingentes.md`: elimina los ya resueltos (por ti, por Codex o por el integrador) y deja SOLO lo que de verdad necesita al dueño, agrupado: (a) herramientas de otras máquinas (cauce-portatil, compilar-en-torre), (b) familia DLQ manual, (c) console-legibilidad, (d) quota-collector, (e) alertmanager (decisión D2 de FASE 3), (f) lo que quede. Una línea de contexto por grupo.

## Tarea 5 — Residuos del host: comandos listos (solo reporte)
Actualiza/crea `ordenes/reportes/minimax-residuos-host.md` con el comando exacto por fila y tamaño: los 13 árboles `/opt/cauce-v3-release-*` (620MB), contenedores de test huérfanos que sigan vivos, imágenes `rc-*`/`*-legacy`/`verificacion-dockerfile-fix` del registry y daemon, y el clon muerto `/datos/workspaces/cauce-v3`. El dueño aprueba; nadie borra.

Al terminar: push + reporte ≤5 líneas.
