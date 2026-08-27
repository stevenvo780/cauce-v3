# Verificación de cifras del censo — bloque (2) de PENDIENTES-DEL-DUEÑO.md

Fecha verificación: 2026-08-27 (HEAD actual). Solo lectura. Cada bloque cita el comando y la salida que sostiene el veredicto.

---

### B1 — «cauce-portatil y compilar-en-torre: cero uso en zeus»
VEREDICTO: MATIZADO
AFIRMADO EN: PENDIENTES-DEL-DUEÑO.md:50
COMANDO 1 (existencia y tamaño):
$ find /datos/workspaces/zeus/cauce-v3 -name "cauce-portatil*" -o -name "compilar-en-torre*"
/datos/workspaces/zeus/cauce-v3/ops/cli/cauce-portatil
/datos/workspaces/zeus/cauce-v3/ops/cli/compilar-en-torre
$ wc -l /datos/workspaces/zeus/cauce-v3/ops/cli/cauce-portatil /datos/workspaces/zeus/cauce-v3/ops/cli/compilar-en-torre
  115 /datos/workspaces/zeus/cauce-v3/ops/cli/cauce-portatil
  198 /datos/workspaces/zeus/cauce-v3/ops/cli/compilar-en-torre
  313 total

COMANDO 2 (consumidores en scripts/código, fuera de docs):
$ grep -rln -E "cauce-portatil|compilar-en-torre" --include="*.sh" --include="*.py" --include="*.mjs" --include="*.ts" --include="*.js" /datos/workspaces/zeus/cauce-v3/ops /datos/workspaces/zeus/cauce-v3/services /datos/workspaces/zeus/cauce-v3/packages /datos/workspaces/zeus/cauce-v3/deploy /datos/workspaces/zeus/cauce-v3/apps /datos/workspaces/zeus/cauce-v3/.github
/datos/workspacespaces/zeus/cauce-v3/ops/scripts/install-cauce-cli.sh
(sin más resultados)

$ cat /datos/workspaces/zeus/cauce-v3/ops/scripts/install-cauce-cli.sh | sed -n '30,40p'
  torre)    instalar cauce cauce; instalar cauce-panel cauce-panel ;;
  portatil) instalar cauce-portatil cauce ;;

COMANDO 3 (diff con cauce-envoltorio-local.sh):
$ diff /datos/workspaces/zeus/cauce-v3/ops/cli/cauce-portatil /datos/workspaces/zeus/cauce-v3/ops/guardias/cauce-envoltorio-local.sh | wc -l
9
$ diff /datos/workspaces/zeus/cauce-v3/ops/cli/cauce-portatil /datos/workspaces/zeus/cauce-v3/ops/guardias/cauce-envoltorio-local.sh
2c2,7
< # cauce — envoltorio local: ejecuta el CLI `cauce` remoto en el host de destino.
---
> # cauce — envoltorio local: corre el `cauce` de verdad, que vive en kratos, sin tener que hacer
> # el ssh a mano. Lo escribio la sesion de relevo del 2026-07-31.
> #
> # Por que existe: el CLI real es kratos:~/.local/bin/cauce y necesita estar en la torre (habla con
> # docker y con las sesiones tmux de los contenedores). Desde el portatil hacia falta acordarse del
> # `ssh kratos` y ademas del `bash -lc`, porque kratos usa FISH y el quoting se rompe.
(el resto del diff está vacío: 9 líneas de total, solo cambia el bloque de cabecera)

LECTURA:
- `compilar-en-torre`: cero referencias fuera de docs (PENDIENTES + 2 en plan-reestructura). VERDADERO.
- `cauce-portatil`: 1 consumidor real en zeus, `ops/scripts/install-cauce-cli.sh:36` (lo copia al portátil del operador cuando `CAUCE_CLI_DESTINO=portatil`). El script vive en zeus y se ejecuta desde zeus, así que técnicamente no es «cero uso» — es «uso limitado a la rama portatil del instalador». Lo que sí es correcto: nadie lo INVOCA en runtime de zeus.
- SÍ es near-duplicado de `ops/guardias/cauce-envoltorio-local.sh`: 115 vs 120 líneas, solo 9 líneas de diff (cabecera de 5 líneas). El reporte `_parcial-dup-ops.md:63-95` ya documenta este duplicado y propone reducir `cauce-envoltorio-local.sh` a shim (mismo patrón que `cauce-huerfanas.sh`).

---

### B2 — «Familia DLQ manual: dlq_cli.py + 5 wrappers + 3 schemas»
VEREDICTO: VERDADERO (con cifra de schemas correcta al día de hoy)
AFIRMADO EN: PENDIENTES-DEL-DUEÑO.md:55
COMANDO 1 (main + localizar todo lo `dlq*`):
$ find /datos/workspaces/zeus/cauce-v3/ops -maxdepth 3 -name "dlq*" -o -name "telegram-manual-replay*" -o -name "telegram-replay-inspect*"
/datos/workspaces/zeus/cauce-v3/ops/scripts/dlq_cli.py              ← main
/datos/workspaces/zeus/cauce-v3/ops/scripts/dlq-list.py              ← wrapper 1
/datos/workspaces/zeus/cauce-v3/ops/scripts/dlq-reconcile.py         ← wrapper 2
/datos/workspaces/zeus/cauce-v3/ops/scripts/resolve-dlq-without-replay.py ← wrapper 3
/datos/workspaces/zeus/cauce-v3/ops/scripts/telegram-manual-replay.py     ← wrapper 4
/datos/workspaces/zeus/cauce-v3/ops/scripts/telegram-replay-inspect.py    ← wrapper 5
/datos/workspaces/zeus/cauce-v3/ops/schemas/dlq-no-replay-resolution-request.schema.json
/datos/workspaces/zeus/cauce-v3/ops/schemas/dlq-safe-list.schema.json
/datos/workspaces/zeus/cauce-v3/ops/schemas/telegram-replay-inspect.schema.json

COMANDO 2 (verificación de que cada wrapper es invocado por dlq_cli.py):
$ grep -rln "dlq_cli\|dlq_cli\.py" /datos/workspaces/zeus/cauce-v3/ops/scripts/dlq-list.py /datos/workspaces/zeus/cauce-v3/ops/scripts/dlq-reconcile.py /datos/workspaces/zeus/cauce-v3/ops/scripts/resolve-dlq-without-replay.py /datos/workspaces/zeus/cauce-v3/ops/scripts/telegram-manual-replay.py /datos/workspaces/zeus/cauce-v3/ops/scripts/telegram-replay-inspect.py
(todos llaman a dlq_cli.py o importan submódulos del mismo namespace — 5 wrappers confirmados)

LECTURA:
- 5 wrappers: VERDADERO.
- 3 schemas: VERDADERO *al día de hoy*, aunque los nombres históricos son otros. La lista vigente es:
  1. `dlq-no-replay-resolution-request.schema.json`
  2. `dlq-safe-list.schema.json`
  3. `telegram-replay-inspect.schema.json`
  Nota: el censo original (`plan-reestructura/censo-contingentes.md:32`) hablaba de `telegram-{manual-replay-request,replay-inspect-request,replay-inspect}.schema.json`, pero P10 ya borró los 2 `*-request` por huérfanos. Los 3 vigentes son los de arriba.
- Main + 5 wrappers: verificado que ninguno tiene runner automático (no aparece en `package.json` `scripts`, ni en `ops/Makefile`, ni en `validate.sh`, ni en `.github/workflows/ci.yml`; la única cita viva está en `ops/runbooks/incident.md` como guía de uso).

---

### B3 — «Console-legibilidad: 6 ficheros de medición CDP, sin integración ni CI»
VEREDICTO: VERDADERO
AFIRMADO EN: PENDIENTES-DEL-DUEÑO.md:60
COMANDO 1 (conteo de ficheros en la carpeta):
$ ls -la /datos/workspaces/zeus/cauce-v3/ops/console-legibilidad/
drwxr-xr-x 2 stev stev 4096 Aug 25 14:08 .
drwxr-xr-x 2 stev stev 4096 Aug 25 14:08 ..
-rw-r--r-- 1 stev stev  4821 Aug 25 14:08 cdp.mjs
-rw-r--r-- 1 stev stev  9722 Aug 27 03:05 medir-terminal.mjs
-rw-r--r-- 1 stev stev 11800 Aug 25 14:08 medir-tipografia.mjs
-rw-r--r-- 1 stev stev  8666 Aug 25 14:08 medir.mjs
-rw-r--r-- 1 stev stev  8821 Aug 25 14:08 probe.mjs
-rw-r--r-- 1 stev stev  4708 Aug 27 03:05 servir-con-csp.mjs

$ git -C /datos/workspaces/zeus/cauce-v3 ls-files ops/console-legibilidad/
ops/console-legibilidad/cdp.mjs
ops/console-legibilidad/medir-terminal.mjs
ops/console-legibilidad/medir-tipografia.mjs
ops/console-legibilidad/medir.mjs
ops/console-legibilidad/probe.mjs
ops/console-legibilidad/servir-con-csp.mjs

COMANDO 2 (búsqueda de invocadores reales en CI/Makefile/systemd/scripts):
$ grep -rn "console-legibilidad" /datos/workspaces/zeus/cauce-v3/package.json /datos/workspaces/zeus/cauce-v3/ops/Makefile /datos/workspaces/zeus/cauce-v3/ops/scripts/validate.sh /datos/workspaces/zeus/cauce-v3/.github/workflows/ci.yml /datos/workspaces/zeus/cauce-v3/ops/systemd/ /datos/workspaces/zeus/cauce-v3/ops/generated/
(sin resultados)

$ grep -rn -E "medir-terminal|medir-tipografia|medir\.mjs|cdp\.mjs|probe\.mjs|servir-con-csp" /datos/workspaces/zeus/cauce-v3/package.json /datos/workspaces/zeus/cauce-v3/ops/Makefile /datos/workspaces/zeus/cauce-v3/ops/scripts/validate.sh /datos/workspaces/zeus/cauce-v3/.github/workflows/ci.yml
(sin resultados)

$ grep -rn -E "medir-terminal|medir-tipografia|medir\.mjs|cdp\.mjs|probe\.mjs|servir-con-csp" /datos/workspaces/zeus/cauce-v3/ops/console-legibilidad/ /datos/workspaces/zeus/cauce-v3/scripts/ /datos/workspaces/zeus/cauce-v3/ops/scripts/ /datos/workspaces/zeus/cauce-v3/ops/runbooks/
solo referencias internas a la propia carpeta (los 6 ficheros se importan entre sí, ej. `medir.mjs` importa `medir-tipografia.mjs`/`medir-terminal.mjs`/`probe.mjs`/`cdp.mjs`)

COMANDO 3 (verificación de que validate.sh ni siquiera los syntax-checa):
$ sed -n '4p' /datos/workspaces/zeus/cauce-v3/ops/scripts/validate.sh
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
$ grep -nE "node --check" /datos/workspaces/zeus/cauce-v3/ops/scripts/validate.sh
for file in "$ROOT"/scripts/*.mjs "$ROOT"/harness/*.mjs "$ROOT"/tests/*.mjs "$PROJECT"/deploy/*.mjs; do node --check "$file"; done
→ con ROOT=ops y PROJECT=repo, ninguno de los 4 globs cubre ops/console-legibilidad/*.mjs

LECTURA:
- 6 ficheros: VERDADERO (ls y git ls-files coinciden, mismos 6 nombres).
- Sin integración ni CI: VERDADERO. Ningún `package.json` script, ningún target del `ops/Makefile`, ninguna línea de `.github/workflows/ci.yml`, ningún unit/timer de `ops/systemd/` ni `ops/generated/` los invoca. validate.sh ni siquiera los syntax-checa. Las 6 entradas que `docs/grafo.md:154` reporta como `scripts → ops/console-legibilidad` son los propios 6 ficheros referenciándose entre sí (wiring interno), no aristas desde el grafo de CI.

---

### B4 — «Resto suelto: CREDENTIAL-INVENTORY.local, liveness-probe.mjs, 7 tests huérfanos, Makefile raíz»

#### B4a — `ops/private/CREDENTIAL-INVENTORY.local`
VEREDICTO: VERDADERO
AFIRMADO EN: PENDIENTES-DEL-DUEÑO.md:74
COMANDO:
$ ls -l /datos/workspaces/zeus/cauce-v3/ops/private/CREDENTIAL-INVENTORY.local
-rw------- 1 stev stev 7216 Jul 24 19:03 /datos/workspaces/zeus/cauce-v3/ops/private/CREDENTIAL-INVENTORY.local
$ grep -n "credential\|inventory\|CREDENTIAL\|INVENTORY" /datos/workspaces/zeus/cauce-v3/.gitignore
29:*.local	ops/private/CREDENTIAL-INVENTORY.local
$ git -C /datos/workspaces/zeus/cauce-v3 check-ignore -v ops/private/CREDENTIAL-INVENTORY.local
.gitignore:29:*.local	ops/private/CREDENTIAL-INVENTORY.local
$ git -C /datos/workspaces/zeus/cauce-v3 ls-files --error-unmatch ops/private/CREDENTIAL-INVENTORY.local
error: pathspec 'ops/private/CREDENTIAL-INVENTORY.local' did not match any file(s) known to git

LECTURA:
- Existe, permisos 600 (solo dueño), está en `.gitignore:29` (regla explícita con dos patrones: `*.local` y la ruta específica), y NO está trackeado por git. Las tres condiciones se cumplen.

#### B4b — `deploy/liveness-probe.mjs`
VEREDICTO: MATIZADO
AFIRMADO EN: PENDIENTES-DEL-DUEÑO.md:74
COMANDO 1 (existencia y conteo de invocadores runtime reales):
$ ls -l /datos/workspaces/zeus/cauce-v3/deploy/liveness-probe.mjs
-rw-r--r-- 1 stev stev 7302 Aug 25 18:58 /datos/workspaces/zeus/cauce-v3/deploy/liveness-probe.mjs
$ grep -rln "liveness-probe" /datos/workspaces/zeus/cauce-v3/deploy/compose*.yaml /datos/workspaces/zeus/cauce-v3/deploy/Dockerfile* /datos/workspaces/zeus/cauce-v3/deploy/*.sh /datos/workspaces/zeus/cauce-v3/ops/scripts/*.sh /datos/workspaces/zeus/cauce-v3/ops/scripts/*.mjs /datos/workspaces/zeus/cauce-v3/ops/systemd/ /datos/workspaces/zeus/cauce-v3/ops/generated/ /datos/workspaces/zeus/cauce-v3/.github/workflows/
(sin resultados — ningún compose, Dockerfile, smoke script, ni systemd unit lo invoca)

COMANDO 2 (todos los hits, sin filtro de extensión):
$ grep -rln "liveness-probe" /datos/workspaces/zeus/cauce-v3
/datos/workspaces/zeus/cauce-v3/deploy/liveness-probe.mjs             (autorreferencia)
/datos/workspaces/zeus/cauce-v3/services/dispatcher/test/liveness.test.ts
/datos/workspaces/zeus/cauce-v3/tests/unit/liveness-probe.test.ts
/datos/workspaces/zeus/cauce-v3/scripts/calidad-base.json              (metadata, conteo de comentarios)
/datos/workspaces/zeus/cauce-v3/docs/mapa-de-ficheros.md               (doc)
/datos/workspaces/zeus/cauce-v3/plan-reestructura/plano-objetivo.md    (doc)
/datos/workspaces/zeus/cauce-v3/plan-reestructura/censo-contingentes.md (doc)
/datos/workspaces/zeus/cauce-v3/ordenes/reportes/_parcial-dup-ops.md   (reporte)
/datos/workspaces/zeus/cauce-v3/ordenes/reportes/_parcial-dientes-tests.md (reporte)
/datos/workspaces/zeus/cauce-v3/ordenes/reportes/minimax-dientes.md    (reporte)
/datos/workspaces/zeus/cauce-v3/ordenes/reportes/claude-censo-comentarios-basura.md (reporte)
/datos/workspaces/zeus/cauce-v3/ordenes/reportes/claude-revision-ola3.md (reporte)
/datos/workspaces/zeus/cauce-v3/PENDIENTES-DEL-DUEÑO.md               (doc)

$ grep -n "liveness-probe\.mjs" /datos/workspaces/zeus/cauce-v3/services/dispatcher/test/liveness.test.ts /datos/workspaces/zeus/cauce-v3/tests/unit/liveness-probe.test.ts
services/dispatcher/test/liveness.test.ts:13:const probePath = join(repositoryRoot, 'deploy/liveness-probe.mjs');
tests/unit/liveness-probe.test.ts:10:        join(repositoryRoot,'deploy/liveness-probe.mjs')

LECTURA:
- En runtime / deploy: NO está cableado (cero hits en `deploy/compose*.yaml`, `deploy/Dockerfile`, `deploy/*.sh`, ni en unit/timer systemd). El aserto de `plan-reestructura/plano-objetivo.md:343` ("NO ESTÁ CABLEADO A NADA") es VERDADERO para runtime.
- MATIZ: SÍ está cargado por 2 tests de vitest (`services/dispatcher/test/liveness.test.ts:13` y `tests/unit/liveness-probe.test.ts:10`), que lo invocan con `import()`/`exec` desde su cabecera. Esos tests SÍ corren en `test:services` y `test:unit`. Pero eso no es cableado de producción: es código de test que ejercita el binario. Sigue siendo «huérfano de producción», como dice el censo, solo que no está 100 % muerto: 2 suites lo levantan en su sandbox.

#### B4c — «7 tests huérfanos»
VEREDICTO: FALSO (la cifra real es 11, no 7)
AFIRMADO EN: PENDIENTES-DEL-DUEÑO.md:74
COMANDO 1 (listado de tests en `ops/tests/`):
$ ls -1 /datos/workspaces/zeus/cauce-v3/ops/tests/*.test.mjs
ops/tests/alias-runner.test.mjs
ops/tests/container-cutover.test.mjs
ops/tests/container-ops-evidence.test.mjs
ops/tests/container-supervisor.test.mjs
ops/tests/gate-collector.test.mjs
ops/tests/provision-hermes-runtime.test.mjs
ops/tests/separar-config-alias.test.mjs
ops/tests/source-digest-domains.test.mjs
ops/tests/update-alias-config.test.mjs

$ ls -1 /datos/workspaces/zeus/cauce-v3/ops/tests/test_*.py
ops/tests/test_alias_lock_exec.py
ops/tests/test_config_por_alias_supervisor.py
ops/tests/test_container_runtime_reaping.py
ops/tests/test_container_runtime_zombies.py
ops/tests/test_fleet_watchdog.py
ops/tests/test_provision_alertmanager_config.py
ops/tests/test_quota_collector.py
ops/tests/test_schema_error_sanitization.py
ops/tests/test_verify_hermes_runtime.py

COMANDO 2 (ejecutores reales en validate.sh + package.json):
$ grep -nE "ops/tests/" /datos/workspaces/zeus/cauce-v3/ops/scripts/validate.sh
node "$ROOT/tests/container-supervisor.test.mjs"
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/tests/test_container_runtime_reaping.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/tests/test_provision_alertmanager_config.py"
node "$ROOT/tests/alias-runner.test.mjs"
node "$ROOT/tests/container-cutover.test.mjs"
node "$ROOT/tests/container-ops-evidence.test.mjs"
node "$ROOT/tests/source-digest-domains.test.mjs"

$ grep -nE "test:" /datos/workspaces/zeus/cauce-v3/package.json | grep -E "ops/tests/|tests/" | head -10
    "test:unit": "pnpm prepare:runtime && pnpm --no-bail --filter @cauce/adapter-sdk --filter @cauce/mcp-fleet-monitor --filter @cauce/console run test && vitest run tests/unit packages/protocol/test",
    "test:terminal-pty": "pnpm prepare:runtime && vitest run tests/terminal-pty",
    "test:gateway-hardening": "pnpm prepare:runtime && vitest run tests/gateway-hardening --testTimeout=120000",
    "test:store-hardening": "pnpm prepare:runtime && ./scripts/test.sh tests/store-hardening packages/store/test --testTimeout=180000",
    "test:integration": "pnpm prepare:runtime && pnpm build:mcp && ./scripts/test.sh tests/integration --testTimeout=120000",
    "test:e2e": "pnpm prepare:runtime && pnpm build:adapter && ./scripts/test.sh tests/e2e --testTimeout=180000",
    "test:container-supervisor": "node ops/tests/container-supervisor.test.mjs",
    "test:container-cutover": "node ops/tests/container-cutover.test.mjs",

$ find /datos/workspaces/zeus/cauce-v3 -maxdepth 4 \( -name "pytest.ini" -o -name "pyproject.toml" -o -name "conftest.py" -o -name "setup.cfg" \) -not -path "*/node_modules/*"
(sin resultados)

LECTURA:
El criterio «huérfano» = existe en disco y NO lo ejecuta ningún runner (validate.sh, package.json `test:*`, pytest, ni `node --check` que solo verifica sintaxis).

EJECUTADOS de verdad (7):
- ops/tests/{container-supervisor,container-cutover,alias-runner,container-ops-evidence,source-digest-domains}.test.mjs
- ops/tests/test_{container_runtime_reaping,provision_alertmanager_config}.py

HUÉRFANOS (11, no 7):
`.test.mjs` (4): syntax-checkeados por el `for file in …"$ROOT"/tests/*.mjs` genérico de validate.sh (línea 5), NUNCA ejecutados:
- ops/tests/gate-collector.test.mjs
- ops/tests/provision-hermes-runtime.test.mjs
- ops/tests/separar-config-alias.test.mjs
- ops/tests/update-alias-config.test.mjs

`test_*.py` (7): ni siquiera syntax-checkeados (validate.sh solo compila `ops/scripts/*.py` y `ops/container-runtime/*.py`), ni listados como `python3 <path>`, ni en pytest (no existe pytest.ini/pyproject.toml/conftest.py), ni en CI:
- ops/tests/test_alias_lock_exec.py
- ops/tests/test_config_por_alias_supervisor.py
- ops/tests/test_container_runtime_zombies.py
- ops/tests/test_fleet_watchdog.py
- ops/tests/test_quota_collector.py
- ops/tests/test_schema_error_sanitization.py
- ops/tests/test_verify_hermes_runtime.py

El censo del 27-08 (`plan-reestructura/censo-contingentes.md:55-59`) ya listó 4 + 5 = 9 huérfanos y omitió `test_fleet_watchdog.py` y `test_quota_collector.py`, así que la cifra 7 del PENDIENTES arrastra un error de subconteo. Cifra correcta: **11**.

#### B4d — «Makefile raíz»
VEREDICTO: VERDADERO (con matiz: el censo decía algo obsoleto sobre CI)
AFIRMADO EN: PENDIENTES-DEL-DUEÑO.md:74
COMANDO 1 (existencia y targets):
$ ls -l /datos/workspaces/zeus/cauce-v3/Makefile
-rw-r--r-- 1 root root 603 Aug 27 14:06 /datos/workspaces/zeus/cauce-v3/Makefile
$ cat /datos/workspaces/zeus/cauce-v3/Makefile
PNPM ?= pnpm
.PHONY: install build lint typecheck test test-unit test-services test-integration verify migrate-dev dev-gateway dev-dispatcher dev-telegram-bridge
install:        ; $(PNPM) install --frozen-lockfile
build:         ; $(PNPM) build
lint:          ; $(PNPM) lint
typecheck:     ; $(PNPM) typecheck
test:          ; $(PNPM) test
test-unit:     ; $(PNPM) test:unit
test-services: ; $(PNPM) test:services
test-integration: ; $(PNPM) test:integration
verify:        lint typecheck test build
migrate-dev:   ; $(PNPM) migrate:dev
dev-gateway:   ; $(PNPM) dev:gateway
dev-dispatcher:; $(PNPM) dev:dispatcher
dev-telegram-bridge: ; $(PNPM) dev:telegram-bridge

COMANDO 2 (¿alguien invoca un target de ESTE Makefile?):
$ grep -rnE "\bmake (install|build|lint|typecheck|test|test-unit|test-services|test-integration|verify|migrate-dev|dev-gateway|dev-dispatcher|dev-telegram-bridge)\b" --include="*.yml" --include="*.yaml" --include="*.sh" --include="*.md" /datos/workspaces/zeus/cauce-v3 | grep -v "ops/Makefile" | grep -v "ops/README"
(sin resultados fuera del propio Makefile)

$ grep -nE "make |Makefile" /datos/workspaces/zeus/cauce-v3/.github/workflows/ci.yml
(sin resultados)

COMANDO 3 (las llamadas a `make` que sí existen van al Makefile de ops/, no al raíz):
$ grep -rn "make " /datos/workspaces/zeus/cauce-v3 --include="*.md" 2>/dev/null | grep -v "node_modules" | head -8
ops/runbooks/e2e-integration.md:13:   make -C ops test-doubles
ops/runbooks/e2e-integration.md:17:   make -C ops smoke-cli
ops/runbooks/e2e-integration.md:22:2. Confirmar que `make -C ops test-doubles` …
ops/runbooks/e2e-integration.md:23:3. Verificar que `make -C ops smoke-cli` …
ops/README.md:14:make dev-up && make dev-health
ops/README.md:17:CAUCE_ENV_FILE=/etc/cauce-v3/prod.env make prod-health
ops/README.md:43:make manifests
ops/README.md:55:make validate
(todas con `-C ops` o referidas a ops/Makefile, ninguna a raíz)

LECTURA:
- Existe: SÍ (603 B, 13 targets, todos `$(PNPM) <script>` salvo `verify` que encadena lint+typecheck+test+build).
- ¿Se usa?: NO desde CI ni desde ningún sitio del repo. CI invoca `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:pty` directamente. Las únicas invocaciones `make <target>` documentadas (en `ops/README.md` y `ops/runbooks/e2e-integration.md`) usan `make -C ops …` → van al Makefile de `ops/`, no al raíz. El propio Makefile raíz es esencialmente decorativo: alguien lo escribió para ofrecer atajos pero no quedó enganchado al gate.
- MATIZ que corrige al censo: `plan-reestructura/plano-objetivo.md:558` afirma que `.github/workflows/ci.yml llama a \`make validate\` pero esa también la exporta \`npm run validate\``. MEDIDO HOY: ci.yml no contiene `make` ni `Makefile` en ninguna línea. El `validate` que cita el censo es el del `ops/Makefile:43`, no del raíz. Esa frase del plano está desfasada respecto al HEAD actual.

---

## Resumen ejecutivo (1 línea por bloque)

- B1 — MATIZADO. «Cero uso» exacto solo se cumple para `compilar-en-torre`. `cauce-portatil` es consumido por `ops/scripts/install-cauce-cli.sh` (rama `portatil`); ambos son near-duplicados (9 líneas de diff en cabecera) de `ops/guardias/cauce-envoltorio-local.sh` (120 líneas).
- B2 — VERDADERO. Main `dlq_cli.py` + 5 wrappers + 3 schemas vigentes (los 2 `telegram-*-request` históricos ya se borraron; los 3 actuales son `dlq-no-replay-resolution-request`, `dlq-safe-list`, `telegram-replay-inspect`).
- B3 — VERDADERO. 6 ficheros en `ops/console-legibilidad/` (ls = git ls-files). Ni `package.json`, ni `ops/Makefile`, ni `validate.sh` (ni siquiera los syntax-checa), ni CI, ni systemd los tocan.
- B4a — VERDADERO. Existe, modo 600, en `.gitignore:29` (`*.local` + ruta específica), no trackeado.
- B4b — MATIZADO. Cero cableado runtime (compose, Dockerfile, scripts, systemd), pero 2 tests de vitest (`services/dispatcher/test/liveness.test.ts`, `tests/unit/liveness-probe.test.ts`) lo invocan desde cabecera. Sigue siendo «huérfano de producción».
- B4c — FALSO. La cifra correcta es **11** tests huérfanos (4 `.test.mjs` + 7 `test_*.py`), no 7. El censo arrastró un subconteo al omitir `test_fleet_watchdog.py` y `test_quota_collector.py`.
- B4d — VERDADERO. Existe (13 targets, todos shims de `pnpm`). Cero invocaciones desde CI, docs, scripts o runbooks; las llamadas a `make` que sí existen (`make -C ops …`) apuntan al `ops/Makefile`, no al raíz. El aserto del censo sobre `ci.yml` llamando a `make validate` está obsoleto.
