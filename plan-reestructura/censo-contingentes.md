# Censo de participación real (2026-08-27)

208 ficheros/familias censados en `ops/` y zonas sospechosas por 11 agentes + refutación adversarial de cada "muerto". Resultado: **29 muertos confirmados dos veces** (ejecución en `ordenes/ronda4/opencode-minimax.md`), **45 dudosos** (tabla abajo, decide el dueño), el resto vivos.

## Hallazgos notables (más allá de la lista)

1. **`ops/patches/` está VIVO y activo**: el guard de openclaw-turn-compaction corre AHORA en 5/6 contenedores — y **falta en `claw-iza` (posible regresión a vigilar)**. Se reaplica a mano, sin systemd: candidato a formalizar.
2. **El toolbox real del operador es `/datos/agents/shared/.local/bin`**: salvó de la cuarentena a `cauce-huerfanas` y `cauce-reponer` (parecían muertos; tienen uso real documentado).
3. **Drift de observabilidad**: el Prometheus vivo monta una versión VIEJA de `prometheus.yaml`/`alerts.yaml` (faltan ~10 grupos de alertas del repo). Se resuelve en FASE 3 (decisión D2 del dossier).
4. **`ops/generated/`**: la familia `container-systemd/rootless/` es la que corre (byte a byte igual a las unidades user activas); las familias system/root y host-native jamás se instalaron → cuarentena.
5. **La familia openclaw-gateway del repo está funcionalmente reemplazada**: sus 2 instancias llevan 1,5–2 semanas failed/dead y quien mantiene vivo el gateway es el guardián NO VERSIONADO de `/usr/local/sbin` (refuerza `plan-reestructura/32` §B).
6. **Rotura ya reparada**: mi cuarentena de rollback-bridge dejó `ops:manifests`/`validate.sh` crasheando (digest exigía ficheros movidos). Corregido en `42b044a`; ambos rc=0.

## Overrides del integrador sobre el censo

- `ops/scripts/quota-collector.py`: el refutador lo dio por muerto (unidad no instalada aquí), pero la base productiva escribe muestras de cuota frescas — **NO se mueve** hasta aclarar quién colecta (¿kratos?, ¿otro camino?). Pasa a dudosos.
- Los 4 restantes de `ops/scripts` (guard-check, retire-session-host, selftest-postgres, smoke-authentic-restarts): se mueven SOLO tras re-verificación in situ (instrucción en ronda 4), por colindar con la zona activa de Codex.

## Los 45 dudosos — decide el dueño (conservar / _legado / borrar)

| Ruta | Evidencia (resumen) |
|---|---|
| ops/cli/cauce-portatil | Solo referenciado por ops/scripts/install-cauce-cli.sh (rama 'portatil': instalar cauce-portatil como `cauce`). Diseñado explícitamente para el PORTÁTIL del ope |
| ops/cli/compilar-en-torre | CERO referencias en el resto del árbol git (git grep 'compilar-en-torre' fuera de sí mismo: nada — ni docs, ni package.json, ni Makefile, ni CI). Herramienta de |
| ops/private/CREDENTIAL-INVENTORY.local | nadie ejecuta ni referencia este fichero por diseño: está en .gitignore vía patrón '*.local' (confirmado con git status --ignored), no está trackeado por git (s |
| ops/console-legibilidad/* [6 ficheros: cdp.mjs, medir-terminal.mjs, medir-tipografia.mjs, medir.mjs, probe.mjs, servir-con-csp.mjs] | Veredicto de familia. Wiring interno real: cdp.mjs lo importan medir.mjs/medir-terminal.mjs/medir-tipografia.mjs; probe.mjs lo importa medir.mjs. Fuera de la fa |
| ops/openclaw-gateway/argos.env.example | Plantilla de documentación; ningún script la lee en caliente (el supervisor lee ~/.config/cauce-v3/openclaw-gateway/<alias>.env, no el .example). Se desplegó ig |
| ops/config/quota-collector-account-bindings.json.example | Solo lo referencia ops/runbooks/quota-collector.md (runbook operativo, no docs/bitácora, pero es documentación, no ejecución). Sin unidad systemd, sin crontab ( |
| ops/config/quota-collector.env.example | Referenciado por ops/runbooks/quota-collector.md y por el docstring de ops/scripts/quota-collector.py (mismas claves: CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE, CAUCE_Q |
| ops/observability/alertmanager.yaml | Vivo en el código: deploy/compose.alertmanager.yaml lo monta vía CAUCE_ALERTMANAGER_CONFIG_PATH, ops/scripts/validate.sh (target real: ops/Makefile y package.js |
| ops/schemas/build-evidence.schema.json | SÍ tiene validador real: validate-release-evidence.py:77 (validate_schema) y release-candidate.py:1006. Ambos siguen en ops/scripts/ (no movidos aún) e invocado |
| ops/schemas/dlq-no-replay-resolution.schema.json | git grep exacto del nombre de fichero = 0 hits (solo su propio $id). dlq_cli.py:410-416 valida esa respuesta con checks manuales de campos (exact_keys), sin car |
| ops/schemas/dlq-reconciliation.schema.json | git grep exacto = 0 hits (solo su propio $id). dlq_cli.py:256 valida el concepto 'cauce-v3-dlq-causal-reconciliation' a mano, sin referenciar este fichero. Sin  |
| ops/schemas/fleet-snapshot.schema.json | git grep exacto = 0 hits reales (el único 'hit' era substring dentro del nombre physical-fleet-snapshot.schema.json). Ningún script ni test lo carga por nombre; |
| ops/schemas/gate-snapshot.schema.json | Solo mencionado en ops/runbooks/alias-cutover.md:5 como el formato que debe escribir un 'collector externo, read-only y específico del entorno' vía $CAUCE_GATE_ |
| ops/schemas/migration-integrity-evidence.schema.json | Validador real inline en ops/scripts/migration-integrity-gate.sh:18 (jsonschema por stdin) y release-candidate.py:1011-1012/1305-1310. migration-integrity-gate. |
| ops/schemas/physical-fleet-snapshot.schema.json | git grep exacto = 0 hits (solo su propio $id, título 'for deterministic gate tests'). Ningún script/test lo carga por nombre; no se encontró generador ni consum |
| ops/schemas/release-candidate.schema.json | Cargado en release-candidate.py:1380 (schema_definition = load(...)) y testeado en ops/tests/container-ops-evidence.test.mjs y source-digest-domains.test.mjs. r |
| ops/schemas/release-writer-snapshot.schema.json | git grep exacto del nombre de fichero = 0 hits (solo su propio $id). El concepto 'cauce-v3-release-writer-snapshot' lo maneja release-writer-state.py con checks |
| ops/schemas/rollback-baseline.schema.json | Validador real: rollback-baseline.py:126-140 (_schema/_validate_report con Draft202012Validator), invocado desde deploy-release.sh, capture-release-writer-snaps |
| ops/schemas/telegram-manual-replay.schema.json | git grep exacto = 0 hits (solo su propio $id). dlq_cli.py:408-440 valida esa respuesta a mano sin cargar el .schema.json; ningún test lo ejercita con jsonschema |
| ops/schemas/test-evidence.schema.json | Validador real: validate-release-evidence.py:193 y release-candidate.py:1008-1009. Mismos consumidores de la 'maquinaria de release' fichada en plan-reestructur |
| ops/schemas/testcontainers-evidence.schema.json | Validador real: validate-testcontainers-evidence.py:81, release-candidate.py:1159-1160, source-digest.py:197. release-candidate.py es la pieza central de la maq |
| ops/schemas/verification-evidence.schema.json | Validador real: release-candidate.py:1004. Mismo caso: consumidor exclusivo es la maquinaria de release fichada en plan-reestructura/12-cuarentena-legado.md com |
| ops/generated/systemd/* (cauce-v3-alias-<alias>.service x15 + SHA256SUMS) [16 ficheros] | Generador (generate-units.py) y drift-check (ops/scripts/validate.sh) funcionan HOY sin error: regenerado en /tmp da diff=0 byte a byte contra lo checked-in. In |
| ops/scripts/deploy-release.sh, pin-production-release.py, release-build.sh, release-candidate.py, release-console.sh, release-gate.sh, release-writer-state.py, rollback-baseline.py, rollback.sh, verification-rounds.mjs, bootstrap-prod-env.py, fleet-gate-mode.sh [12 ficheros] | en-curso-codex: excluidos de evaluación por instrucción explícita (maquinaria de release que otro agente está moviendo). No se censan. |
| ops/scripts/systemd-stack.sh | Solo lo ejecutaría la plantilla ops/systemd/cauce-v3-compose@.service, NO instalada en este sistema. tests/unit/deploy-release.test.ts (test:unit, vivo) solo co |
| ops/scripts/diff-consola-visible.py | grep=0 en todo el árbol (ni docs). Herramienta manual de diff entre builds de consola con instrucciones de uso en su propio docstring; sin invocación automatiza |
| ops/scripts/dlq-list.py, dlq-reconcile.py, resolve-dlq-without-replay.py, telegram-manual-replay.py, telegram-replay-inspect.py [5 ficheros, familia wrappers de dlq_cli.py] | grep=0 externo para los 5; ninguna unidad systemd/cron ni código de consola/servicios los invoca. Su librería común (dlq_cli.py) tiene un test dedicado (ops/tes |
| ops/scripts/dlq_cli.py | Librería de los 5 wrappers anteriores (todos dudosos); su único test (ops/tests/test_dlq_cli.py) es huérfano. Último commit 2026-08-26. |
| ops/scripts/preflight.sh | Única referencia externa: ops/runbooks/alias-cutover.md (doc). Sin test, sin Makefile, sin llamador interno en ops/scripts (grep interno solo se referencia a sí |
| ops/scripts/healthcheck.mjs | Única referencia: ops/harness/Dockerfile; no se encontró ningún `docker build` que use ese Dockerfile en el repo. Último commit 2026-07-23. |
| ops/scripts/generate-telegram-config.py | Solo ops/tests/test_generate_telegram_config.py y test_telegram_cutover_preflight.py, ambos huérfanos (no en validate.sh). El contenedor cauce-v3-prod-telegram- |
| ops/scripts/telegram-cutover-preflight.py | ops/runbooks/telegram-cutover.md (doc) + ops/tests/test_telegram_cutover_preflight.py, huérfano. Sin invocación automatizada. Último commit 2026-07-24. |
| ops/scripts/aplicar-separacion-config.sh | Único referenciador: ops/tests/aplicar-separacion-config.test.mjs, huérfano (no en validate.sh). Feature CONFIG_POR_ALIAS que implementa está APAGADA por defect |
| ops/scripts/censo-config-por-alias.py | Solo ops/tests/aplicar-separacion-config.test.mjs y test_censo_config_por_alias.py, ambos huérfanos. Mismo cluster CONFIG_POR_ALIAS (apagado por defecto). Últim |
| ops/scripts/separar-config-alias.mjs | Su test dedicado ops/tests/separar-config-alias.test.mjs es huérfano. Aparece mencionado en un COMENTARIO dentro de ops/tests/container-supervisor.test.mjs (ese |
| ops/scripts/update-alias-config.py | Único referenciador: ops/tests/update-alias-config.test.mjs, huérfano (no en validate.sh ni package.json). Último commit 2026-08-26. |
| ops/scripts/ut-nexus-backup.py, ut-nexus-backup-verify.py [2 ficheros] | UT_NEXUS_ENABLED=0 explícito en /etc/cauce-v3/host-backup.env de esta máquina (deshabilitado aquí). host-backup.sh apunta por defecto a /opt/_archive/ultimate-t |
| ops/scripts/fault-compose.test.sh | grep=0 de ejecución; solo aparece LISTADO (no ejecutado) dentro del manifiesto hardcodeado de source-digest.py (línea 184), que lo hashea pero no lo corre. Últi |
| ops/tests/gate-collector.test.mjs, provision-hermes-runtime.test.mjs, separar-config-alias.test.mjs, aplicar-separacion-config.test.mjs, update-alias-config.test.mjs [5 ficheros] | grep=0 en validate.sh/ops-Makefile/package.json/CI; solo los toca el bucle genérico `node --check "$ROOT"/tests/*.mjs` de validate.sh (verifica sintaxis, no eje |
| ops/tests/test_alias_lock_exec.py, test_censo_config_por_alias.py, test_config_por_alias_supervisor.py, test_container_runtime_zombies.py, test_dlq_cli.py, test_generate_telegram_config.py, test_release_writer_rotation.py, test_schema_error_sanitization.py, test_telegram_cutover_preflight.py, test_verify_hermes_runtime.py [10 ficheros] | grep=0 de cada basename fuera de ops/tests (ni Makefile, ni package.json, ni validate.sh, ni runbooks, ni .github/workflows/ci.yml); no existe pytest.ini/pyproj |
| ops/tests/test_fleet_watchdog.py, test_quota_collector.py + fixtures/account-bindings-sample.json, fixtures/ai-usage-sample.json, fixtures/fake_quota_server.py [5 ficheros] | sin runner automático: grep=0 en validate.sh/Makefile/package.json/CI. Único referenciador es un comando manual documentado en ops/runbooks/fleet-watchdog.md y  |
| packages/adapter-sdk/scripts/package-smoke.mjs | Solo referenciado por su propio script npm "smoke:package" en packages/adapter-sdk/package.json ('node scripts/package-smoke.mjs'); ningún otro fichero del árbo |
| deploy/compose.alertmanager.yaml | NO está en config_files de ningún contenedor vivo; no hay contenedor alertmanager en docker ps -a; NO aparece en ninguna rama de ops/scripts/compose-files.sh (n |
| deploy/liveness-probe.mjs | Grep de código de producción: 0 referencias en deploy/compose*.yaml, deploy/Dockerfile (la lista COPY del Dockerfile no lo incluye) ni en ops/scripts/*. Docker  |
| Makefile | Grep exhaustivo de 'make <target>' sobre todo el repo (excl. _legado/docs/bitacora) = 0 apariciones fuera del propio Makefile; .github/workflows/ci.yml llama a  |
