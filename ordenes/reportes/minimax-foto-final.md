# Foto final del repo vivo — ronda 7 minimax (post-descontaminación)

Métricas medidas con `wc -l` sobre `main` (HEAD = `73e533c` + cambios locales de docs). **61 ficheros fuente >800 líneas** sobreviven en el árbol vivo. La cuarentena ya no existe (`_legado/` borrado en `73e533c`); el índice de lo retirado vive en `docs/bitacora/legado-indice.md`.

## (a) Tabla de TODOS los ficheros fuente >800 líneas que quedan en el repo vivo

41 fuente (no test) + 20 test = 61 ficheros, 315.277 líneas sumadas.

### Fuente (no test, 41)

| Ruta | Líneas | Sector dueño |
|---|---|---|
| `ops/pty-agent/cauce_pty_agent.py` | 2667 | Claude+FASE 3 (contenedores/PTY) |
| `packages/adapter-sdk/src/sdk/durable-store.ts` | 2060 | Codex (adapter-sdk) |
| `packages/adapter-sdk/src/shared-session/paste-runner.ts` | 1900 | Codex (adapter-sdk) |
| `packages/adapter-sdk/src/shared-session/tmux.ts` | 1529 | Codex (adapter-sdk) |
| `packages/store/src/repository/deliveries.ts` | 1493 | Codex (store) |
| `packages/store/src/repository/agents/fanin.ts` | 1438 | Codex (store) |
| `packages/store/src/repository/observability.ts` | 1420 | Codex (store) |
| `packages/store/src/repository/agents/chain-control.ts` | 1335 | Codex (store) |
| `packages/adapter-sdk/src/sdk/engine.ts` | 1322 | Codex (adapter-sdk) |
| `packages/store/src/repository/outbox.ts` | 1286 | Codex (store) |
| `services/terminal-relay/src/gateway-client.ts` | 1244 | Gemini (canales) |
| `ops/scripts/update-alias-config.py` | 1244 | **DUEÑO** (dudoso de censo) |
| `services/terminal-relay/src/sessions.ts` | 1235 | Gemini (canales) |
| `ops/pty-agent/rollout-pty.py` | 1220 | Claude+FASE 3 (contenedores/PTY) |
| `packages/adapter-sdk/src/sdk/output-parser.ts` | 1189 | Codex (adapter-sdk) |
| `apps/console/src/api/types.ts` | 1193 | Gemini (consola) |
| `packages/store/src/repository/messages.ts` | 1161 | Codex (store) |
| `packages/protocol/src/schemas.ts` | 1115 | Codex (protocol, subagente A) |
| `packages/store/src/configuration.ts` | 1145 | Codex (store) |
| `services/gateway/src/terminal/relay-proxy.ts` | 1141 | Codex (gateway) |
| `packages/adapter-sdk/src/harnesses/shared.ts` | 1133 | Codex (adapter-sdk) |
| `services/gateway/src/health.ts` | 1375 | Codex (gateway, subagente D) |
| `services/gateway/src/routes/core.ts` | 1448 | Codex (gateway) |
| `services/gateway/src/console/agent-documents.ts` | 1080 | Codex (gateway) |
| `services/terminal-relay/src/agent-leg.ts` | 1065 | Gemini (canales) |
| `ops/container-runtime/cauce-container-runtime.py` | 1664 | **DUEÑO** (sin sector; FASE 3) |
| `ops/scripts/container-adapter-supervisor.sh` | 976 | Codex (ops/scripts) |
| `apps/console/src/features/topology/hypergraph-layout.ts` | 962 | Gemini (consola) |
| `packages/adapter-sdk/src/shared-session/session.ts` | 949 | Codex (adapter-sdk) |
| `apps/console/src/features/live/agent-state.ts` | 875 | Gemini (consola) |
| `apps/console/src/features/terminal/xterm-csp.css` | 869 | Gemini (consola) |
| `apps/console/src/mocks/data.ts` | 856 | Gemini (consola) |
| `apps/console/src/features/live/LiveFleetPage.tsx` | 850 | Gemini (consola) |
| `services/telegram-bridge/src/poller.ts` | 847 | Gemini (canales) |
| `apps/console/src/api/client.ts` | 840 | Gemini (consola) |
| `ops/scripts/generate-telegram-config.py` | 839 | **DUEÑO** (dudoso de censo) |
| `services/gateway/src/terminal/session-control.ts` | 902 | Codex (gateway) |
| `services/gateway/src/routes/console.ts` | 920 | Codex (gateway) |
| `packages/store/src/repository/config.ts` | 896 | Codex (store) |
| `ops/pty-agent/cauce-pty-launcher.sh` | 804 | Claude+FASE 3 (contenedores/PTY) |

Resumen por sector (41 fuente >800): Codex 25 (store 8, gateway 6, adapter-sdk 7, protocol 1, ops/scripts 1, dudoso NO — los dudosos son del dueño) · Gemini 11 (consola 7, canales 4) · Claude+FASE 3 4 (pty-agent 3, container-runtime 1) · **DUEÑO** 3 (ops/scripts dudosos + container-runtime huérfano).

### Test (20)

| Ruta | Líneas | Sector |
|---|---|---|
| `packages/adapter-sdk/test/shared-session.test.ts` | 5454 | Codex |
| `packages/adapter-sdk/test/engine.test.ts` | 2800 | Codex |
| `packages/store/test/agent-output-postgres.test.ts` | 2730 | Codex |
| `services/gateway/src/terminal.plugin.test.ts` | 2020 | Codex |
| `services/telegram-bridge/test/bridge.test.ts` | 1877 | Gemini |
| `ops/tests/container-supervisor.test.mjs` | 1761 | **DUEÑO** (huérfano de ops/tests) |
| `packages/store/test/dlq-causal-reconciliation-postgres.test.ts` | 1406 | Codex |
| `packages/adapter-sdk/test/client.test.ts` | 1339 | Codex |
| `services/terminal-relay/src/relay.test.ts` | 1224 | Gemini |
| `services/gateway/src/health-progress.test.ts` | 1156 | Codex |
| `tests/terminal-pty/relay-contract.test.ts` | 1127 | Gemini |
| `packages/adapter-sdk/test/durable-store.test.ts` | 1100 | Codex |
| `packages/store/test/console-publish-intent-postgres.test.ts` | 981 | Codex |
| `tests/gateway-hardening/delivery-admission.test.ts` | 923 | Codex |
| `services/terminal-relay/src/sessions.test.ts` | 883 | Gemini |
| `tests/store-hardening/adversarial-postgres.test.ts` | 857 | Codex |
| `ops/pty-agent/tests/test_read_governance.py` | 852 | Claude+FASE 3 |
| `tests/gateway-hardening/gateway-security.test.ts` | 849 | Codex |
| `packages/adapter-sdk/test/shared-session-turn-merge.test.ts` | 811 | Codex |
| `apps/console/src/features/config/ConfigPage.test.tsx` | 1248 | Gemini |

Resumen por sector (20 test >800): Codex 13 · Gemini 5 · Claude+FASE 3 1 · **DUEÑO** 1.

## (b) Conteo total de líneas por área vs las cifras de la auditoría de la madrugada

Las cifras de la auditoría de la madrugada (censo `fe5d705`) eran "208 ficheros/familias censados en `ops/` y zonas sospechosas"; el resultado fue **29 muertos confirmados** y **45 dudosos**. Esos 29 (+ ~80 más del censo) se borraron en `73e533c` (185 ficheros, 59.417 líneas, 3.2MB). El "antes y después" por área, sobre `main`:

| Área | Antes (auditoría + git log ronda 4–7) | Hoy (post-`73e533c`) | Neto |
|---|---|---|---|
| `services/` (todo TS/JS/MJS/Py/Sh/CSS/HTML) | ~73K (incluyendo `services/shadow-router` ~2K, `services/relay-worker` ~2K) | 47.239 | **−25.8K** |
| `packages/` (todo TS/TSX/JS/CSS/Py, sin `dist`/`bridge`/`fixtures`/`manifests`) | ~103K (incluyendo el `repository.ts` de 11K) | 74.661 | **−28.3K** (sin contar las particiones de store/gateway/adapter-sdk que se quedaron en sitio) |
| `apps/console/` (todo TS/TSX/JS/CSS, sin `dist`) | ~57,7K (similar) | 57.682 | **−0K** (consola solo se partió, no se descontaminó) |
| `ops/` (todo TS/Py/Sh/MJS/YAML/JSON/CSS, sin `node_modules`) | ~73K (incluyendo `ops/ops-scripts/` ~19K, `ops/contingentes/` ~17K, `ops/harness/CONTRACT.md` + Dockerfile) | 37.689 | **−35K** |
| `tests/` (top-level, todo TS/MJS/Py) | ~21K (similar; las purgadas son `tests/unit/{release-*,rollback-*,migrate-*,pin-*}` etc. que se fueron con la cuarentena) | 21.048 | **−0K** medible (los tests purgados están en `ops/tests/`, no aquí) |
| `_legado/` | ~50K (servicios + ops-scripts + tests + basura + contingentes + rollback-bridge) | **0** (borrado entero en `73e533c`) | **−50K** |

**Las cifras de la columna "antes" mezclan dos cosas que no deberían mezclarse**: la auditoría de la madrugada midió `ops/` específicamente (208 ficheros/familias en `ops/` + zonas sospechosas), mientras las cifras de aquí son sobre `main` entero. Lo que vale comparar es el delta: **3.2M y 185 ficheros borrados en `73e533c`** + las particiones que se quedaron en sitio (store 11K → 9 módulos, gateway monolito → routes/console/terminal).

Para los números exactos de particiones (mudanza byte-pura, sin borrado de líneas):
- `packages/store/src/repository.ts`: **11.002 → 42 líneas** (fachada) + 9 módulos (~7,5K); verificada byte a byte en `docs/bitacora/reportes/claude-revision-46-commits.md` §store-1/store-2.
- `services/gateway/src/app.ts` (antes monolito >2K) → **408 líneas** + `routes/{console,core,health,legado-candidato,shared}.ts` (~2,8K) + `console/*.ts` (~5,2K) + `terminal/*.ts` (~3,5K) + llanos (~3,4K). Total: 15,3K vs el monolito de antes (cifra desconocida con precisión).
- `services/gateway/src/terminal/plugin.ts` (326) está partido en `{audit,authority,config,governance-probes,hechos-del-registro,plugin,registry,relay-proxy,session-control,tickets,types}.ts` (~3,5K en total).
- `apps/console/src/features/terminal/pty-session.ts` (1017) → 6 ficheros (`pty-{connection,session,input,output,theme,types,socket-stub}.ts`); `apps/console/src/features/terminal/OperatorWorkspace.tsx` (1383) → 8 ficheros; `apps/console/src/features/terminal/styles.css` (2012 declaraciones) → 4 módulos; `apps/console/src/features/terminal/live.css` (1123 declaraciones) → 6 módulos. Paridad verificada en `docs/bitacora/reportes/claude-revision-46-commits.md` §consola.

## (c) Los 3 números del día

1. **Cuánto se movió a `_legado/`**: **0**. `_legado/` se BORRÓ ENTERO en `73e533c` (decisión del dueño: `git rm` + evidencia). El histórico de lo que llegó a estar en cuarentena está en `docs/bitacora/legado-indice.md` (25 ops-scripts + 6 schemas + 2 servicios + rollback-bridge + 52 contingentes + 33 tests + 4 informes de `basura/`, ~185 ficheros y ~50K líneas, recuperables por `git log --diff-filter=AD` o el bundle del 27-08).
2. **Cuánto se partió**: **`repository.ts` (11.002 → 42 fachada + 9 módulos ~7,5K)** + **gateway monolito → `app.ts` 408 + 4 routes/* + `console/*` + `terminal/*`** + **`pty-session.ts` 1017 → 6 + `OperatorWorkspace.tsx` 1383 → 8 + 4 módulos CSS + 6 live.css** + **`health.ts` 1375 (Codex subagente D lo está partiendo; sigue >800 hoy)** + **8 commits de store (observabilidad, outbox, jobs, cola, agents/fanin, agents/chain-control, config, messages) + 6 commits de gateway (core, console, relay-proxy, session-control, health, legado-candidato, governance-probes, shared)**. Total: 24 commits de carpintería + el borrado.
3. **Cuánto queda >800**: **61 ficheros / 315.277 líneas** (41 fuente + 20 test; tabla arriba). Los 41 fuente se reparten: Codex 25 · Gemini 11 · Claude+FASE 3 4 · **DUEÑO 3**. Los 20 test: Codex 13 · Gemini 5 · Claude+FASE 3 1 · **DUEÑO 1**.

## Nota metodológica

- Cifras medidas con `find … | xargs wc -l` el 2026-08-27 sobre `main` con `73e533c` HEAD + cambios locales de docs. No incluyen node_modules, `dist`, `.pytest_cache`, `__pycache__`, `.vite/`, `_legado/` (borrado).
- Comparar contra la auditoría de la madrugada exige dos pasos: el censo `fe5d705` (208 ficheros/familias censados en `ops/`) **no** era una métrica de líneas del repo entero, sino un censo de participación real (¿quién invoca este fichero?). El delta de líneas del repo entre "antes" y "después" se ve mejor por commit: `73e533c` borró 185 ficheros y 59.417 líneas; los 24 commits de partición de store + gateway + consola + terminal + adapter-sdk no borraron líneas (mudanza byte-pura) pero sí bajaron el techo de cada "gigante" a <2K por fichero (excepto `cauce_pty_agent.py` que sigue siendo un monolito de 2,7K y queda en el sector de Claude+FASE 3).