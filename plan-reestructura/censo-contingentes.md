# Censo de participación real (2026-08-27)

208 ficheros/familias censados en `ops/` y zonas sospechosas por 11 agentes + refutación adversarial de cada "muerto". Resultado original: **29 muertos confirmados dos veces** (ejecución en `ordenes/ronda4/opencode-minimax.md`), **45 dudosos** (tabla abajo, decide el dueño), el resto vivos.

**Actualización post-rondas 6/7:** los 29 confirmados y ~80 piezas más del censo se borraron del árbol en `73e533c` (3.2M menos, historial en git (--diff-filter=AD)). La doctrina vigente es `git rm` + evidencia en commit; no existen carpetas de cuarentena. La tabla de "dudosos" de abajo es el residuo real: lo que sobrevive en `main` y todavía pide una decisión del dueño.

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

## Lo que aún queda al dueño — agrupado por decisión (post-ronda 7)

Resueltos en ronda 6 por minimax: 6 schemas sin consumidor (`dlq-no-replay-resolution`, `dlq-reconciliation`, `fleet-snapshot`, `gate-snapshot`, `physical-fleet-snapshot`, `telegram-manual-replay`), 5 tests huérfanos y sus 4 scripts sujetos (`aplicar-separacion-config.sh`, `censo-config-por-alias.py`, `diff-consola-visible.py`, `preflight.sh`), `ops/harness/{Dockerfile,.dockerignore}` y `ops/harness/CONTRACT.md` (borrado; historial en git). `healthcheck.mjs` reaparece en stack-health.sh (Makefile + systemd unit) y se conserva en su sitio. Resueltos por Codex (su ronda 3): 7 schemas y 12 scripts de la maquinaria de release. Resueltos en rondas 4-5: `ops/generated/systemd/system` y familia, `package-smoke.mjs` queda para cuando se libere el adapter-sdk. Resueltos en `73e533c` (ronda 7, dueño): los 29 confirmados + la cuarentena entera (services/shadow-router, services/relay-worker, rollback-bridge, 25 ops-scripts, 6 schemas, 52 contingentes, 33 tests, basura) — 3.2M borrados con `git rm`; historial en git (--diff-filter=AD).

### (a) Herramientas de otras máquinas — herramientas pensadas para máquinas distintas a esta

- `ops/cli/cauce-portatil` — único consumidor vivo: `ops/scripts/install-cauce-cli.sh` rama `portatil` (instalar `cauce` en el portátil del operador); no aplica a zeus.
- `ops/cli/compilar-en-torre` — cero referencias en el árbol git (ni docs, ni package.json, ni Makefile, ni CI); herramienta de la torre de compilación.

### (b) Familia DLQ manual — herramientas de emergencia del operador, sin runner

- `ops/scripts/dlq_cli.py` + `ops/scripts/dlq-list.py`, `dlq-reconcile.py`, `resolve-dlq-without-replay.py`, `telegram-manual-replay.py`, `telegram-replay-inspect.py` + sus 3 schemas vivos en `ops/schemas/telegram-{manual-replay-request,replay-inspect-request,replay-inspect}.schema.json`. Los schemas `dlq-{no-replay-resolution,reconciliation}.schema.json` que cita 030_dlq_causal_reconciliation.sql siguen vivos en `ops/schemas/` (los borrados en ronda 6 eran los de la maquinaria de release). Ningún runner automático los invoca; el dueño decide si se quedan como herramientas vivas o se documentan en bitácora.

### (c) Console-legibilidad — tooling de medición de la consola, sin integración

- `ops/console-legibilidad/{cdp.mjs, medir.mjs, medir-terminal.mjs, medir-tipografia.mjs, probe.mjs, servir-con-csp.mjs}` (6 ficheros, wiring interno solo entre sí); sin runner, sin CI, ni referenciado desde fuera de la familia.

### (d) Quota-collector — colecta de cuotas de IA, colector ausente en zeus

- `ops/scripts/quota-collector.py` (override explícito del integrador en este censo: la base escribe muestras, falta decidir quién colecta).
- `ops/config/quota-collector-account-bindings.json.example`, `ops/config/quota-collector.env.example` (plantillas de runbook, sin invocador automático).
- `ops/scripts/ut-nexus-backup.py`, `ut-nexus-backup-verify.py` (UT_NEXUS_ENABLED=0 aquí; corren en otra máquina).
- `ops/tests/test_fleet_watchdog.py`, `ops/tests/test_quota_collector.py` + `ops/tests/fixtures/{account-bindings-sample.json, ai-usage-sample.json, fake_quota_server.py}` (fixtures y tests sin runner).

### (e) Alertmanager — decisión D2 de FASE 3, queda en el limbo por integración pendiente

- `ops/observability/alertmanager.yaml` + `deploy/compose.alertmanager.yaml`: el `compose.alertmanager.yaml` declara el servicio pero no aparece en ninguna rama de `ops/scripts/compose-files.sh`; no hay contenedor alertmanager vivo ni en `config_files` de los contenedores productivos. La unidad existe en código pero no se ejercita.
- `ops/scripts/systemd-stack.sh`: lo invocaría la plantilla `ops/systemd/cauce-v3-compose@.service`, que NO está instalada; `tests/unit/deploy-release.test.ts` solo lo importa como path.

### (f) Resto — herramientas sueltas, una línea cada una

- `ops/private/CREDENTIAL-INVENTORY.local` — fichero `*.local` ignorado por .gitignore; no trackeado; nadie lo referencia. Borrable seguro cuando el dueño autorice.
- `ops/openclaw-gateway/argos.env.example` — plantilla de doc, el supervisor lee `~/.config/cauce-v3/openclaw-gateway/<alias>.env` en caliente.
- `ops/scripts/{generate-telegram-config.py,telegram-cutover-preflight.py}` — referenciados por `ops/runbooks/telegram-cutover.md`, sin invocación automática (los 2 tests asociados ya se borraron con la cuarentena en `73e533c`).
- `ops/scripts/separar-config-alias.mjs`, `ops/tests/separar-config-alias.test.mjs` — el test es huérfano; el script se menciona en un comentario de `container-supervisor.test.mjs` (vivo).
- `ops/scripts/update-alias-config.py`, `ops/tests/update-alias-config.test.mjs` — test huérfano; script vivo solo desde el propio test.
- `ops/scripts/fault-compose.test.sh` — grep=0 de ejecución; solo aparece listado (no ejecutado) en el manifiesto hardcodeado de `source-digest.py:184`.
- `ops/tests/gate-collector.test.mjs`, `provision-hermes-runtime.test.mjs` — huérfanos; los toca el genérico `node --check "$ROOT"/tests/*.mjs` de `validate.sh` (chequeo de sintaxis, no ejecución).
- `ops/tests/{test_alias_lock_exec.py, test_config_por_alias_supervisor.py, test_container_runtime_zombies.py, test_schema_error_sanitization.py, test_verify_hermes_runtime.py}` — huérfanos; sin runner (validate.sh/Makefile/package.json/CI/pytest.ini/pyproject.toml = 0).
- `deploy/liveness-probe.mjs` — 0 referencias en compose*.yaml, deploy/Dockerfile (no en su lista COPY) ni ops/scripts/*. Docker CLI ni `runtime-package-smoke.mjs` lo invocan.
- `Makefile` — `make <target>` aparece 0 veces fuera del propio Makefile (excluyendo docs/bitácora); `.github/workflows/ci.yml` llama a `make validate` pero esa también la exporta `npm run validate`.
