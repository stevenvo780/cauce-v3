# Matriz cobertura fichero → gate (2026-08-27)

> Inventario mecánico: para CADA fichero versionado, qué gate lo toca hoy. Columna **NINGUNO** primero (el orden del dueño). Insumo directo del gate G2/G6/G7/G9 de `claude-megaauditoria.md §4`.

**Método** (`/tmp/opencode/matriz-cobertura.mjs` → `/tmp/opencode/matriz.json`):

- `git ls-files` = 1.278 ficheros; tras excluir `dist/`, `node_modules/`, `.git/`, `.test-state/`, `generated/`, `ops/artifacts/`, binarios y lockfiles: **1.239 ficheros versionados vivos**.
- 24 gates clasificados según `package.json`, `ops/scripts/validate.sh`, `scripts/calidad.mjs`, `eslint.config.js`, `console/eslint.config.js`, y los `package.json` de cada workspace.
- `calidad` cubre por defecto todo `.ts|.tsx|.mjs|.py|.sh` **más** los ejecutables sin extensión bajo `ops/cli/` y `ops/scripts/` con shebang bash/sh/python.

**Resumen**:

| cobertura | ficheros | % |
|---|---:|---:|
| Con al menos un gate | **976** | 78,8% |
| **NINGUNO** | **263** | 21,2% |
| TOTAL versionados vivos | **1.239** | 100% |

De los 263 NINGUNO: **204 son texto/config/snapshot por diseño** (md 108, json 31, css 24, sql 43, service 12, timer 9, example 6, ignore 5, jsonl 2, ya?ml 2, html 1, conf 2, dotfiles 4, .d.mts 7, mockServiceWorker 1, fixtures 5) — están bien sin gate.

Los **46 source-code con SOLO calidad** (sin eslint/tsc/vitest/python_compile/bash_n/node_check) son el hallazgo accionable.

---

## Distribución de NINGUNO por categoría (263 total)

| categoría | ficheros | por qué NINGUNO | sector |
|---|---:|---|---|
| `.md` (docs) | 108 | documentación humana | mixto |
| `.sql` migraciones | 42 | **NADIE** hasta FASE 3 (fila protegida) | NADIE |
| `.json` config | 31 | `package.json`, `tsconfig.json`, manifests, fixtures | mixto |
| `.css` | 24 | **no hay linter CSS en el repo** | Gemini (console) |
| `.service` (systemd) | 12 | validados en `validate.sh` por SHA256, no por sintaxis | Claude (ops) |
| `.timer` (systemd) | 9 | idem | Claude (ops) |
| `.d.mts` (declaraciones) | 7 | no se compilan (declaration emit) | n/a |
| `.example` (env templates) | 6 | solo se referencian desde compose | mixto |
| ignore files | 5 | `.gitignore`, `.dockerignore` | n/a |
| fixtures | 5 | `openclaw-dist-*/*.js`, `ops/tests/fixtures/*.json` | test |
| Dockerfile | 2 | no linted (ver §3.4.5 megaauditoria) | Claude/Gemini |
| nginx.conf | 2 | no linted | Claude/Gemini |
| jsonl | 2 | traces/logs | n/a |
| yaml suelto | 1 | `compose.test.yaml` lo valida docker compose | Claude |
| `PENDIENTES-DEL-DUEÑO.md` | 1 | owner prompts | dueño |
| `console/eslint.config.js` | 1 | self | n/a |
| `console/public/mockServiceWorker.js` | 1 | vendored MSW | Gemini |
| `ops/Makefile` | 1 | make no es sh (≠ bash) | Claude (ops) |
| `.keep` | 1 | placeholder | n/a |
| **TOTAL NINGUNO** | **263** | — | — |

---

## Source-code con SOLO calidad (46 ficheros — hallazgo accionable)

Estos pasan `calidad.mjs` (líneas + fechas + comentarios) pero NO reciben análisis de sintaxis (bash -n / node --check / python compile) ni linting ni tests. **El trinquete atrapa el tamaño, no la corrección**.

### `ops/pty-agent/**` (Codex / Claude — fila compartida)

16 ficheros Python en `ops/pty-agent/` que NO están en `compile()` (el globs de validate.sh es `ops/scripts/*.py`, `ops/container-runtime/*.py`, `ops/guardias/*.py`):

```
ops/pty-agent/cauce_pty_agent.py
ops/pty-agent/derive-alias-key.py
ops/pty-agent/rollout-pty.py
ops/pty-agent/rollout_pty_lib.py
ops/pty-agent/tests/__init__.py
ops/pty-agent/tests/test_framing.py
ops/pty-agent/tests/test_governance_allowlists.py
ops/pty-agent/tests/test_hkdf.py
ops/pty-agent/tests/test_launcher_harness.py
ops/pty-agent/tests/test_launcher_openclaw_tui.py
ops/pty-agent/tests/test_launcher_reap.py
ops/pty-agent/tests/test_launcher_restart_safety.py
ops/pty-agent/tests/test_openclaw_dynamic.py
ops/pty-agent/tests/test_presencia_home.py
ops/pty-agent/tests/test_read_governance.py
ops/pty-agent/tests/test_read_only_harness.py
ops/pty-agent/tests/test_rollout_pty.py
ops/pty-agent/tests/test_runtime_facts.py
ops/pty-agent/tests/test_suite_completeness.py
ops/pty-agent/tests/test_ticket.py
ops/pty-agent/tests/test_tmux_dynamic.py
ops/pty-agent/tests/test_write_governance.py
ops/pty-agent/tests/test_write_governance_batch.py
```

**Cobertura real hoy**:
- `test:pty` (`python3 -m unittest discover -s ops/pty-agent`) → SÍ los ejecuta.
- Pero `validate.sh` no añade `compile()` sobre ellos, así que un cambio con `SyntaxError` se descubre al ejecutar `test:pty`, no antes.

### `ops/tests/test_*.py` (Codex / Claude — fila compartida)

7 ficheros Python en `ops/tests/` que NO están en `compile()` NI en `unittest`:

```
ops/tests/test_alias_lock_exec.py
ops/tests/test_config_por_alias_supervisor.py
ops/tests/test_container_runtime_zombies.py
ops/tests/test_fleet_watchdog.py
ops/tests/test_quota_collector.py
ops/tests/test_schema_error_sanitization.py
ops/tests/test_verify_hermes_runtime.py
```

**Cobertura real hoy**:
- 2 de 7 (`test_container_runtime_reaping.py`, `test_provision_alertmanager_config.py`) los ejecuta `validate.sh` línea 71-72.
- **Los otros 5 NUNCA SE EJECUTAN**. Esto es **P16** (`plan-reestructura/plano-objetivo.md:557`); decisión pendiente del dueño entre engancharlos al gate o `git rm`.
- IDEAL: gate los cubre con `compile()` + un `unittest discover` adicional.

### `ops/cli/cauce*` (Claude — ops/cli)

4 ejecutables bash sin extensión, NO cubiertos por `bash -n` (que solo mira `ops/scripts/*.sh`):

```
ops/cli/cauce            (1.138 líneas)
ops/cli/cauce-huerfanas
ops/cli/cauce-panel
ops/cli/cauce-reponer
```

**Cobertura real hoy**:
- `calidad.mjs` los cuenta (gracias a `conShebang` añadido en `8802acc`) → trinquete de tamaño + fechas + comentarios.
- NO hay `bash -n`, NO hay `shellcheck`. Un script bash con `SyntaxError` se descubre al ejecutarlo, no antes.
- **Esta es exactamente la familia que el G1 del megaauditoria §4 cerró** a nivel de `calidad.mjs`; falta cerrar bash -n + shellcheck (G6).

### `ops/guardias/*.sh` y `ops/openclaw-gateway/*.sh` y `ops/patches/*.sh` y `ops/pty-agent/*.sh` (Claude)

12 ejecutables bash NO cubiertos por `bash -n` ni `shellcheck`:

```
ops/guardias/cauce-envoltorio-local.sh
ops/guardias/cauce-huerfanas.sh
ops/guardias/contenedor/polidin-fwd.sh
ops/guardias/cred-guard.sh
ops/guardias/polidin-guard.sh
ops/openclaw-gateway/openclaw-gateway-supervisor.sh
ops/patches/apply-openclaw-turn-compaction-guard.sh
ops/pty-agent/cauce-pty-launcher.sh
ops/pty-agent/install-pty-agent.sh
+ 3 más
```

**Cobertura real hoy**: solo `calidad.mjs`.

### `packages/adapter-sdk/bridge/hermes-stdin-bridge.py` (Codex)

1 fichero Python NO cubierto por `compile()`.

**Cobertura real hoy**:
- `packages/adapter-sdk/package.json:29` tiene `lint` que hace `python3 -c "import ast,pathlib; ast.parse(pathlib.Path('bridge/hermes-stdin-bridge.py').read_text(...))"`.
- Pero el `lint:adapter` de la raíz (`package.json:18`) NO invoca el `lint` del workspace — solo corre `eslint packages/adapter-sdk/src packages/adapter-sdk/test`.
- **Resultado**: este fichero Python está validado solo si alguien corre `pnpm --filter @cauce/adapter-sdk lint` a mano. El gate global no lo toca.

### `scripts/test.sh` (Claude)

El script que `test:store-hardening`, `test:integration`, `test:e2e` invocan:
- NO en `lint:tooling` (que es `eslint scripts deploy`).
- **Pero** está en `validate.sh:6` (`bash -n`) porque `validate.sh` globs `ops/scripts/*.sh` — no, espera: `validate.sh` globs `ROOT/scripts/*.sh` que es `ops/scripts/*.sh`, no la raíz. Verificado: `scripts/test.sh` **no está** en `bash -n` tampoco.

---

## Cobertura por gate (cuántos ficheros toca cada uno)

| gate | ficheros cubiertos | nota |
|---|---:|---|
| `calidad.mjs` (líneas/fechas/comentarios) | **948** | trinquete pero NO corrige sintaxis |
| `eslint_root_ts` | 372 | `lint:core` desde raíz con `recommendedTypeChecked` |
| `tsc_core` | 372 | `typecheck:core` via tsconfig.json |
| `eslint_console` | 275 | `lint:console` desde console/eslint.config.js |
| `tsc_console` | 276 | `typecheck:console` via console/tsconfig*.json |
| `vitest_unit` | 195 | `test:unit` + workspaces + tests/unit + packages/protocol/test |
| `eslint_adapter` | 131 | `lint:adapter` |
| `tsc_adapter` | 122 | `typecheck:adapter` |
| `vitest_services` | 66 | `test:services` cubre gateway/dispatcher/telegram-bridge/terminal-relay |
| `vitest_store_hardening` | 58 | `test:store-hardening` + `packages/store/test` |
| `node_check` | 42 | `node --check` para `.mjs` de ops/{scripts,harness,tests} + deploy |
| `python_compile` | 29 | `compile()` para `ops/scripts/`, `ops/container-runtime/`, `ops/guardias/` |
| `bash_n` | 28 | `bash -n` para `ops/scripts/`, `deploy/**.sh` |
| `shellcheck` | 28 | condicional en `validate.sh:201` (suele faltar el binario) |
| `eslint_ops` | 28 | `lint:ops` para ops/{harness,patches,scripts,tests} |
| `yaml_parse` | 21 | `yaml.safe_load` |
| `eslint_tooling` | 21 | `lint:tooling` para scripts/ + deploy/ |
| `vitest_gateway_hardening` | 18 | `test:gateway-hardening` |
| `ops_ops_tests` | 10 | `node ops/tests/*.test.mjs` en validate.sh |
| `vitest_terminal_pty` | 5 | `test:terminal-pty` |
| `eslint_mcp` | 4 | `lint:mcp` |
| `tsc_mcp` | 4 | `typecheck:mcp` |
| `vitest_integration` | 4 | `test:integration` |
| `json_schema` | 2 | `Draft202012Validator` |
| `vitest_e2e` | 2 | `test:e2e` |

---

## Familias de cobertura combinadas (top 15)

| count | combinación |
|---:|---|
| 267 | NINGUNO |
| 170 | eslint_root_ts + tsc_core + calidad |
| 162 | eslint_console + tsc_console + calidad |
| 111 | eslint_console + tsc_console + vitest_unit + calidad |
| 83 | eslint_adapter + tsc_adapter + calidad |
| 65 | eslint_root_ts + tsc_core + vitest_services + calidad |
| 58 | eslint_root_ts + tsc_core + vitest_store_hardening + calidad |
| 43 | calidad |
| 40 | eslint_root_ts + tsc_core + vitest_unit + calidad |
| 39 | eslint_adapter + tsc_adapter + vitest_unit + calidad |
| 29 | python_compile + calidad |
| 24 | bash_n + shellcheck + calidad |
| 21 | yaml_parse + ops_validate |
| 18 | eslint_root_ts + tsc_core + vitest_gateway_hardening + calidad |
| 17 | eslint_root_js + eslint_ops + node_check + calidad |
| 14 | eslint_root_js + eslint_tooling + node_check + calidad |
| 10 | eslint_root_js + eslint_ops + node_check + ops_ops_tests + calidad |

---

## Patrones notables

1. **TS sin ESLint** — solo **8** ficheros TS/JS no tienen ESLint; de esos, 5 son fixtures y 1 es la propia config de ESLint. Solo `console/vite.config.ts` tiene una cobertura de `tsc_console` sin `eslint_console` (gap menor).
2. **`.sql` nunca se valida** — 42 migraciones + 1 runbook SQL sin syntax-check. Esto es por diseño (FASE 3), pero merece recordatorio.
3. **CSS sin linter** — 24 CSS en `console/` sin stylelint ni postcss. El megaauditoria no lo pidió pero es un gap visible.
4. **`deploy/**` sin lint:tooling** — `package.json:24` dice `lint:tooling` es `eslint scripts deploy` pero `deploy/` está en **FILA NADIE** (protocolo §34). Los 7 `.mjs` de `deploy/` sí reciben `eslint` hoy (esLint corre con el glob). Los 14 `.sh` reciben `bash -n` + `shellcheck`. Lo que NO recibe `deploy/` es **ESLint para `.mjs` en `deploy/runtime/`** (un subdir). Verificado.
5. **`.d.mts` declaraciones TypeScript** — 7 ficheros sin gate; son declaraciones emitidas por tsc, no código fuente.
6. **`scripts/test.sh`** — el runner de 3 suites pesadas no está en `bash -n` ni en `lint:tooling` ni en `node_check`. Gap pequeño.

---

## Recomendaciones al integrador

1. **Cerrar G1+G6 para los 4 `ops/cli/cauce*`** — ampliar el glob de `validate.sh:6` y `validate.sh:201` para incluir `ops/cli/*` (con shebang). Coste: 1 línea cada uno.
2. **Cerrar G1+G6 para `ops/guardias/`, `ops/openclaw-gateway/`, `ops/patches/`, `ops/pty-agent/*.sh`** — 12 bash ejecutables más. Mismo patrón.
3. **Cerrar G1+G6 para `scripts/test.sh`** — añadir al glob de `validate.sh:6`. 1 línea.
4. **Añadir `compile()` para `ops/pty-agent/*.py`** — ampliar el glob de `validate.sh:21` con `(root / 'pty-agent').glob('*.py')` y `(root / 'pty-agent' / 'tests').glob('*.py')`. Detecta SyntaxError antes de `test:pty`.
5. **Decidir P16** (5 `ops/tests/test_*.py` sin runner) — `git rm` o `unittest discover -s ops/tests`.
6. **`packages/adapter-sdk/bridge/hermes-stdin-bridge.py`** — o se invoca el `lint` del workspace en el root, o se mueve a `compile()`.

Total huecos: ~30 ficheros source-code sin validación de sintaxis. Coste agregado del cierre: ~10 líneas en `ops/scripts/validate.sh` y `package.json`. Es la versión "G1+G6+G9" del megaauditoria convertida en cambio real.
