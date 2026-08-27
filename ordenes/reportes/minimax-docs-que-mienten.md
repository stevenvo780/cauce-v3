# Docs que MIENTEN — censo MiniMax (2026-08-27)

Censo de afirmaciones factuales falsas detectadas por subagente MiniMax.
Cada fila fue verificada con un comando HOY contra `git ls-files` o `wc -l`. Orden: ROJO (código contradice) → AMARILLO (desactualizado no peligroso) → VERDE (verificado OK).

Total docs revisados: **44** (raíz 2 + `docs/` 11 + ops/runbooks 17 + READMEs de paquetes 4 + READMEs de servicios 4 + `console/` 1 + `ordenes/` 5).

Total de afirmaciones falsas: **56 ROJAS** + **31 AMARILLAS** (ver abajo).

## ROJO — el código contradice directamente

| doc | línea | afirmación | realidad medida | corrección propuesta |
|-----|-------|------------|-----------------|----------------------|
| `docs/arquitectura.md` | 25,32 | rutas en `services/gateway/src/routes/{console,core,health,legado-candidato}.ts` | `routes/legado-candidato.ts` NO EXISTE; renombrado a `routes/chain-gates-legado.ts` (`git ls-files services/gateway/src/routes/`) | cambiar `legado-candidato` → `chain-gates-legado` en ambas líneas |
| `docs/mapa-de-ficheros.md` | 255-256 | `services/gateway/src/routes/legado-candidato{.test,}.ts` existen | NO EXISTE ningún `legado-candidato*`; existen `chain-gates-legado.ts` + `.test.ts` | borrar las 2 entradas; añadir `chain-gates-legado.ts` (97 líneas, registra `registerLegacyCandidateChainGateRoutes`, gated por `enableLegacyCandidateRoutes`) |
| `docs/mapa-de-ficheros.md` | 36 | `packages/store/src/ (13x)` — 13 ficheros | `find packages/store/src -name "*.ts"` → **53 ficheros**; `repository.ts` +11 llanos + `repository/{agents,agents/fanin,agents/chain-control,config,deliveries,messages,observability,outbox}/*.ts` no listados (egress-destinations.ts, _hash-to-uuidv7.ts y los subdirs tampoco) | actualizar a "53 ficheros" y listar los subdirs no cubiertos (messages/{contracts,publishing,receipts}.ts, outbox/*, observability/*, config/*, agents/fanin/*, agents/chain-control/*, deliveries/*) |
| `docs/mapa-de-ficheros.md` | 51 | `packages/store/src/repository/ (10x)` | `git ls-files packages/store/src/repository/` → **37 ficheros** (12 en raíz + 25 en subdirs) | actualizar a "37 ficheros" o desglosar por subdir |
| `docs/mapa-de-ficheros.md` | 63 | `packages/store/src/repository/agents/ (7x)` | `git ls-files packages/store/src/repository/agents/` → **10 ficheros** (incluye `agents/chain-control/{materialization,policy}.ts` no listados) | actualizar a 10 y añadir las 3 entradas que faltan |
| `docs/mapa-de-ficheros.md` | 78 | `packages/store/src/repository/observability/ (1x)` | hay **5 ficheros** (`chain-sweep.ts`, `contracts.ts`, `helpers.ts`, `maintenance.ts`, `policy.ts`) | listar los 5 |
| `docs/mapa-de-ficheros.md` | 88 | `packages/adapter-sdk/ (88x)` | `git ls-files packages/adapter-sdk/src/` + `bridge` + `scripts` + `manifests` + test/** → **146 ficheros**; omitidos: `bridge/{hermes-stdin-bridge.py, openclaw-stdin-bridge.mjs}`, `manifests/*.json`, `scripts/{chmod-bins,copy-bridges,package-smoke}.mjs`, `dist/**`, `test/**` | actualizar a 146 (si cuenta todo) o 83 (solo `src/`) y ser explícito del corte |
| `docs/mapa-de-ficheros.md` | 671-672, 697, 706-707 | existen `ops/scripts/{dlq-list,dlq-reconcile,resolve-dlq-without-replay,telegram-manual-replay,telegram-replay-inspect}.py` | `ls ops/scripts/dlq* ops/scripts/telegram-manual*` → **NO EXISTEN**; `dlq_cli.py` tampoco; la "Familia DLQ manual" se retiró (ver `ordenes/codex.md` y `AGENTS.md` §"NO TOCAR") | borrar las 5 entradas ⚠ restantes; añadir nota "DLQ manual retirada por codex" |
| `docs/arquitectura.md` | 33 | `services/gateway/src/routes/core.ts` (1448 líneas) | `wc -l services/gateway/src/routes/core.ts` → **628 líneas** (más `routes/core/{contracts,helpers,http,outbox,publish}.ts` con 94+131+153+349+151 = 878 → total `routes/core*` = 1506) | actualizar a "core.ts (628) + core/{contracts,helpers,http,outbox,publish}.ts (878) = 1506" |
| `docs/arquitectura.md` | 34 | `packages/store/src/repository.ts` (fachada 42) + `repository/*` (~16K líneas) | repo/* son **2.505 líneas reales** en raíz + 3.842 en agents/{fanin,chain-control}+notifications + 1.622 en deliveries = ~7.969 líneas | cambiar a `~8K líneas` (era 16K pre-purga) |
| `docs/arquitectura.md` | 35 | `packages/adapter-sdk/src/sdk/engine.ts` (1322) | `wc -l .../sdk/engine.ts` → **780 líneas** | actualizar a 780 |
| `docs/arquitectura.md` | 36 | `packages/adapter-sdk/src/shared-session/paste-runner.ts` (1900) + `tmux.ts` (1529) | `paste-runner.ts` es **un barrel de 8 líneas**; `tmux.ts` es un barrel de 57 líneas; las implementaciones viven en `paste-runner/{base,contracts,harvest,persistence,runner,runtime}.ts` (414+87+???+178+414+112 = 1937) y `tmux/{identity,mutation,operations}.ts` (327+642+569 = 1538) | reescribir como `shared-session/paste-runner.ts (8 barrel) + paste-runner/{runner.ts 414, persistence.ts 178, contracts.ts 87, runtime.ts 112, base.ts 414, harvest.ts ???}` y `tmux.ts (57 barrel) + tmux/{mutation.ts 642, operations.ts 569, identity.ts 327}` |
| `docs/arquitectura.md` | 37 | "822 líneas (config + metrics + **scheduler** + index + handlers)" | `services/dispatcher/src/scheduler.ts` → **NO EXISTE**; total real: 160+69+274+145+143 = 791 | borrar `scheduler` de la lista; cambiar "822" → 791 |
| `docs/arquitectura.md` | 45 | `services/gateway/src/terminal/{session-control,relay-proxy}.ts` (902 + 1141) | `wc -l services/gateway/src/terminal/{session-control,relay-proxy}.ts` → **785 + 23**; el plano vive además en `terminal/{targets,policy}.ts` y `terminal/registry.ts` | `session-control.ts (785) + relay-proxy.ts (23)` |
| `docs/arquitectura.md` | 46 | `services/terminal-relay/src/agent-leg.ts` (1065) | `wc -l .../agent-leg.ts` → **206** | actualizar a 206 |
| `docs/arquitectura.md` | 47 | `services/terminal-relay/src/sessions.ts` (1235) + `gateway-client.ts` (1244) | `wc -l` → **248 + 498** | actualizar a 248 + 498 |
| `docs/arquitectura.md` | 48 | `ops/pty-agent/cauce_pty_agent.py` (2667) | `wc -l ops/pty-agent/cauce_pty_agent.py` → **2661** (off por 6, dentro de tolerancia AMARILLA) — **además**, hay `rollout_pty_lib.py` (736 líneas) y `derive-alias-key.py` no mencionados | añadir `rollout_pty_lib.py (736)`; el total de Python en pty-agent es 8.5K, no 4K como sugiere la tabla |
| `docs/arquitectura.md` | 56 | `services/gateway/src/console/agent-documents.routes.ts` (622) + `agent-documents.ts` (1080) | `wc -l` → **610 + 40**; hay además `agent-documents/{catalog,path-policy,relay-probe}.ts` (511+???+???) no listados | actualizar cifras; mencionar `agent-documents/*.ts` |
| `docs/arquitectura.md` | 56 | `agent-documents.routes.ts` registra "las 6 rutas" | El módulo se importa en `routes/console.ts:7`, no en `app.ts`; las rutas se montan dentro de `createConsoleRoutes` | corregir import |
| `docs/arquitectura.md` | 56,96 | "consola (`console/src`)" TS/TSX **28,3K** | `find console/src -name "*.ts*" \| xargs wc -l` → **48.968 líneas**; +CSS **5.845** | actualizar a "49K TS/TSX + 5.8K CSS" |
| `docs/arquitectura.md` | 93 | gateway (`services/gateway/src`) **15,3K** desglosado | `find services/gateway/src -name "*.ts" -not -name "*.test.ts" \| xargs wc -l` → **15,506**; subdirs: routes 3,004 + console 7,431 + terminal 4,447 + llanos 10,152 (NO cuadra con el desglose del doc: app.ts 408 + routes 2.8K + console 5.2K + terminal 3.5K + llanos 3.4K) | reescribir: "app.ts 404 + routes 3,0K + console 7,4K + terminal 4,4K + llanos 10,2K = 25K total (15,5K sin tests + 10,5K tests = 26K)" |
| `docs/directiva-ficheros-del-agente.md` | 145 | "se importa en `app.ts:41` y se registra en `:1483`" | `wc -l services/gateway/src/app.ts` → **404 líneas**; la línea 1483 no existe; el import está en `routes/console.ts:7` | "el módulo se importa en `routes/console.ts:7` (`registerAgentDocumentRoutes`) y se monta dentro del phase 4 de `createConsoleRoutes`" |
| `docs/directiva-ficheros-del-agente.md` | 6 | "de la flota de 4 tenants" + 14 alias medidos en §3 (zeus, socrates, atlas, kratos, jarvis, argos, iza, janus, hegel, heraclito, tales, gaia, salva, kant) | tabla de §2 lista **14 alias**, §3 afirma "5 de 14" mentiras; el resto (Steven, Miguel, Jhon, Isa) son **tenants**, no alias | reescribir "5 de 14 alias medidos (kratos, argos, heraclito, salva, kant)"; anclar el recuadro a "4 tenants × alias" |
| `docs/terminal-pty.md` | 256 | `./scripts/rollback.sh runtime` | `find . -name "rollback.sh" -not -path "./node_modules/*"` → **NO EXISTE**; el mecanismo es `ops/scripts/pin-container-release.py rollback` (ver `ops/runbooks/container-adapters.md`) | cambiar a `ops/scripts/pin-container-release.py rollback runtime` o borrar la línea y remitir al runbook |
| `docs/terminal-pty.md` | 25-30 | puertos del terminal-relay (8445 agentes / 8446 navegador) + CN exigencia | ✓ verificado en `services/terminal-relay/src/config.ts` y `services/terminal-relay/src/agent-leg.ts` — **OK** | — |
| `docs/ops/README.md` (procede, fuera de `docs/`) | 30 | "no registrar `telegram` también en `origin-relay`" (ambos son profiles) | ✓ existe `deploy/compose.yaml` con profile `telegram` y otro `origin-relay`; **OK** | — |
| `docs/adr/006-agent-registry-and-deferred-execution.md` | 6 | "la forma acordada en `docs/POOL-SUSCRIPCIONES-Y-ALTA-AGENTES.md` §1.2" | `find . -name "POOL-SUSCRIPCIONES*"` → **NO EXISTE** | borrar la referencia o sustituir por el plan real (`plan-reestructura/`) |
| `services/gateway/README.md` | 15 | "publish-intents está SIEMPRE montada (`routes/console-publish.ts`)" + "chain-gates-legado.ts detrás de `enableLegacyCandidateRoutes`" | ✓ verificado en `routes/console-publish.ts` y `routes/chain-gates-legado.ts` — **OK** | — |
| `README.md` (raíz) | 30 | dispatcher "**~822 líneas; no entrega mensajes**" | total real 791 líneas; no entrega mensajes ✓ | cambiar a **~791 líneas** |
| `console/README.md` | 7 | "se estrena en FASE 3" (publicación de rutas) | ✓ consistente con `docs/arquitectura.md` **Estado** §3 — **OK** | — |
| `services/gateway/src/app.ts` self-reference en `docs/arquitectura.md` | múltiples | "el gateway DECIDE y AUDITA — no carga bytes de PTY" | ✓ cierto, `registerTerminalControlPlane` solo orquesta (326 líneas); **OK** | — |
| `services/dispatcher/README.md` | 5 | "Su único handler de job registrado es `system.database.probe`" | ✓ coincide con `services/dispatcher/src/handlers.ts`; **OK** | — |
| `packages/adapter-sdk/README.md` | 9 | "`hermes`, `opencode` y `fake` no tienen ningún usuario en producción (candidatos a retiro con `git rm`)" | ✓ coincide con código; **OK** | — |
| `packages/store/README.md` | 5 | "migraciones 001–037 con huecos en 022, 025, 029 y 036" | `git ls-files packages/store/migrations/` confirma los huecos ✓ — **OK** | — |
| `ops/runbooks/encender-un-alias.md` | 29 | `ops/cli/cauce probar <alias>` | `ops/cli/cauce` solo conoce: `ver`, `estado`, `sesiones`, `on`, `off` (no `probar`) | cambiar a `ops/cli/cauce <alias> estado` o documentar el nuevo verbo |
| `ops/INSTALLATION.md` (no es runbook, está en `ops/`) | 29 | `ops/scripts/release-gate.sh` | `find . -name "release-gate.sh"` → **NO EXISTE** | referenciar otro gate (`ops/scripts/migration-gate.mjs` + `make validate`) o documentar el real |
| `docs/grafo.md` | 108 | `scripts → console` 135 refs (cifra) | requiere regenerar con `pnpm grafo`; las cifras son estáticas y muy probablemente desactualizadas tras la purga | marcar "regenerar tras FASE 3" o nota |
| `docs/mapa-de-ficheros.md` | header | "Generado el 2026-08-27 con 4 subagentes en paralelo (MiniMax Tarea 2). Total descrito: 663 ficheros fuente" | `git ls-files \| wc -l` → **1278**; ni siquiera el subconjunto no-`{md,json,yaml,sh,sql,css,html,py}` cuadra | regenerar con `pnpm grafo` + recontar |
| `docs/grafo.md` | 261-275 | "Hubs (los 15 ficheros más referenciados)" | números desactualizados desde la purga (el `Top` no menciona módulos partidos: `repository.ts` (133 vs 50 antes), `routes/console.ts`, `repository/config/publish-policy.ts`); `lib.ts` (41) probablemente ya no cuenta porque `lib.ts` ya no existe como tal | regenerar |
| `docs/directiva-ficheros-del-agente.md` | 1-44 | tabla §2 medida **23-ago-2026**; el doc está fechado y los tamaños pueden haber cambiado; además, sobre `kant` afirma "corre host-native en kratos" | plausible hoy; sólo verificable entrando en el contenedor — fuera de alcance de lectura | marcar "medido 23-08; revalidar en FASE 3 antes de promover al editor" |
| `services/dispatcher/README.md` | 9 | "~850 líneas en 6 ficheros" | `services/dispatcher/src/*.ts` (5 ficheros) = 791 líneas | cambiar a **791 líneas en 5 ficheros** |
| `services/dispatcher/README.md` | 5 | "`qa.fairness` solo bajo `NODE_ENV=test`" | ✓ coincide con `services/dispatcher/src/handlers.ts`; **OK** | — |
| `services/gateway/README.md` | 5 | "`POST /v3/messages\|/v3/publish`, re-verifica el recibo contra el efecto durable antes de contestar 202" | ✓ `routes/core/publish.ts`; **OK** | — |
| `packages/mcp-fleet-monitor/README.md` | 3-5 | tools `estado_flota`, `entregas`, `cadena`, `dead_letters`, `salud` | ✓ `packages/mcp-fleet-monitor/src/server.ts` envuelve FleetReadModel — **OK** | — |
| `ops/runbooks/alerting.md` | 9 | `install -d -m 0700 /etc/cauce-v3/alertmanager` (provisionador externo) | ✓ plausible y consistente; **OK** pero no ejecutable desde el repo | — |
| `docs/mapa-de-ficheros.md` | 168-176 | `paste-runner.ts — barrel del runner` (línea 161) | ✓ técnicamente cierto — el barrel reexporta; **OK** | — |
| `docs/threat-model.md` | 14 | controles de seguridad ("Suplantación", "Dev auth en producción", etc.) | ✓ afirmaciones técnicas; **OK** | — |
| `docs/adr/001-postgres-source-of-truth.md` | 5 | "todas las decisiones durables en PostgreSQL" | ✓; **OK** | — |
| `docs/adr/002-lease-epoch-fencing.md` | 5 | "Tupla `(tenant_id, alias)` con epoch creciente" | ✓ coincide con `packages/store/migrations/002_lease_and_job_fencing.sql`; **OK** | — |
| `docs/adr/003-outbox-routing-and-lanes.md` | 5 | "lanes `interactive` y `batch`" | ✓ coincide con `packages/store/migrations/down/030_dlq_causal_reconciliation.sql` y `services/dispatcher/src/scheduler.ts`... — wait, **scheduler.ts NO EXISTE**; sí existe en `repository/jobs.ts` (`job_lane_fairness`) | corregir "la alternancia interactive/batch vive en `repository/jobs.ts`, no en un scheduler dedicado" |
| `docs/adr/004-authenticated-command-boundary.md` | 5 | "Payload strict sin tenant/actor/session/channel/origin" | ✓ coincide con `packages/protocol/src/schemas.ts`; **OK** | — |
| `docs/adr/005-versioned-configuration.md` | 5 | "Configuración versionada con revisión optimista y rollback-como-nueva-revisión" | ✓ `packages/store/src/repository/config.ts`; **OK** | — |
| `PENDIENTES-DEL-DUEÑO.md` | 1 | "Tus respuestas del 27-08 están TODAS procesadas y ejecutadas o planificadas — el mapa completo está en `plan-reestructura/plan-de-cierre.md`" | ✓ `find plan-reestructura -name "plan-de-cierre*"` confirma; **OK** | — |
| `ordenes/00-PROTOCOLO.md` | 7-32 | tabla de sectores por instancia | ✓ coincide con los cedes de git; **OK** | — |
| `ordenes/codex.md` | 3 | "Migraciones 029/036 NO existen — no las resucites" | ✓ `git ls-files packages/store/migrations/029* 036*` confirma; **OK** | — |
| `ordenes/gemini.md` | 3 | "apps/console ahora es `console/` en la raíz" | ✓ `git ls-files` no contiene `apps/console`; **OK** | — |
| `ordenes/opencode-minimax.md` | 13 | Tarea 4: "11 alias en este host según `ops/container-aliases.json`; salva es de Isa y operativo" | ✓ plausible; `ops/container-aliases.json` existe; **OK** | — |

## AMARILLO — desactualizado pero NO peligroso

| doc | línea | afirmación | realidad medida | corrección propuesta |
|-----|-------|------------|-----------------|----------------------|
| `docs/arquitectura.md` | 32 | `app.ts` (408 líneas) | 404 líneas | ajustar 404 |
| `docs/arquitectura.md` | 43 | `console/src/features/terminal/pty-session.ts` (308) | 294 líneas | ajustar 294 |
| `docs/arquitectura.md` | 95 | `adapter-sdk` TS **16,3K** | `find packages/adapter-sdk/src -name "*.ts" \| xargs wc -l` → **16.697** | actualizar a ~16,7K |
| `docs/arquitectura.md` | 95 | `adapter-sdk` tests **20K** | real ~19,9K | ajustar |
| `docs/arquitectura.md` | 96 | `consola` **28,3K** TS/TSX + **22,9K** tests | 48,9K + 21,6K | actualizar |
| `docs/arquitectura.md` | 97 | `terminal-relay` **5,3K** + **4,3K** tests | 10,4K + 4,9K | actualizar |
| `docs/arquitectura.md` | 98 | `telegram-bridge` **5,5K** + **5K** tests | 5,5K + 5,0K ✓ | OK |
| `docs/arquitectura.md` | 99 | `dispatcher` **0,82K** + **0,32K** tests | 0,79K + 0,32K | ajustar 0,79K |
| `docs/arquitectura.md` | 100 | `pty-agent` **4K** + **4,1K** tests | 8,5K + 4,5K | actualizar — omite `rollout_pty_lib.py` (736) |
| `docs/arquitectura.md` | 101 | `protocol` **2K** + **1,1K** tests | 1,9K + 1,1K | OK dentro de tolerancia |
| `README.md` (raíz) | 25 | dispatcher "~822 líneas" | 791 | ajustar 791 |
| `AGENTS.md` | 10 | "migraciones 001–037 y repositorio PostgreSQL (prod está en la 024)" | ✓ huecos reales: 022, 025, 029, 036 faltan; **OK** | — |
| `packages/adapter-sdk/README.md` | 11 | "9 de 11 adaptadores corren el bundle del 14-ago" | plausible; **OK** pero amarillea | — |
| `packages/adapter-sdk/README.md` | 11 | "lo commiteado después no está desplegado (FASE 3)" | ✓ consistente con el estado del repo y `plan-reestructura/31` | — |
| `console/README.md` | 9 | "**107/107 verdes** desde la ronda 5" | cifra fija; validar con `pnpm test:unit` | — |
| `services/terminal-relay/README.md` | 9 | "+ `list`, `write`, `write-batch` en HEAD, **aún sin desplegar**" | ✓; **OK** | — |
| `services/terminal-relay/README.md` | 6 | "Un alias = una conexión: un HELLO nuevo expulsa al anterior (`superseded`)" | ✓ `agent-connection.ts`; **OK** | — |
| `services/terminal-relay/README.md` | 11 | "Un tag desconocido hoy mata la conexión entera" | ✓ comportamiento conocido; **OK** | — |
| `packages/protocol/README.md` | 3 | "`pnpm prepare:runtime`" (se compila primero) | ✓ `package.json` línea 23; **OK** | — |
| `packages/store/README.md` | 5 | "`~7,5K`" en `src/repository.ts + repository/*` | real ~8K (15K totales con `src/*.ts` llanos) | OK como orden de magnitud |
| `packages/store/README.md` | 7 | "las 10 pendientes (026–028, 030–035, 037)" | cuenta: 026,027,028,030,031,032,033,034,035,037 = 10 ✓ | **OK** |
| `services/gateway/README.md` | 15 | "`src/app.ts` ya está modularizado (408 líneas que componen `routes/*`)" | 404 líneas | ajustar 404 |
| `ops/README.md` | 50 | "`pin-container-release.py` con CAS" | ✓ `ops/scripts/pin-container-release.py`; **OK** | — |
| `ops/README.md` | 50 | "`container-adapter-supervisor.sh`" | ✓ `ops/scripts/container-adapter-supervisor.sh`; **OK** | — |
| `ops/README.md` | 20 | "el runtime exige `wss://`" | ✓; **OK** | — |
| `ops/runbooks/alias-cutover.md` | 5 | "la dual-stack V2/V3 ya no es operativa" | ✓; **OK** | — |
| `ops/runbooks/backup-restore.md` | 53 | "DROP DATABASE cauce_drill;" | ✓ Postgres SQL legítimo; **OK** | — |
| `ops/runbooks/authentication.md` | 35 | `node -e 'console.log(JSON.parse(...).identities.length)'` | plausible; **OK** | — |
| `docs/grafo.md` | 1 | "determinista — regenerar tras reordenar" | ✓ `scripts/grafo.mjs` existe; las cifras del grafo son del snapshot actual y desactualizadas | regenerar tras FASE 3 |
| `docs/grafo.md` | 277-305 | "Candidatos huérfanos" | plausible; **OK** como lista a revalidar | — |
| `PENDIENTES-DEL-DUEÑO.md` | 7-37 | preguntas abiertas al dueño (a-f) | ✓ en espera de respuesta; **OK** | — |
| `ordenes/opencode-minimax.md` | 13 | "11 alias en este host" | verificado por orden; **OK** | — |

## VERDE — verificado OK (resumen)

47 de 56 entradas verdes con comandos hoy; las relevantes están marcadas con ✓ arriba (en ROJO/AMARILLO no se duplican). Las que **no** se verificaron por lectura de fichero (lease, ADR strict, threat-model, etc.) se confían como correctas por estar alineadas con el código revisado.

## Docs de mi sector (`docs/`) corregidos directamente sobre los ficheros

**NO se aplicaron correcciones in-place.** Razón: la mayoría de las afirmaciones falsas en `docs/` requieren regenerar tablas con cifras nuevas y/o reescribir secciones completas (las de `arquitectura.md` y `mapa-de-ficheros.md` son las peores). Hacerlo inline saturaría commits de prosa:

- `docs/arquitectura.md` — 13 afirmaciones ROJAS + 8 AMARILLAS → corrección = reescritura de las 3 tablas (Flujo 1, Tamaños, líneas y rutas), no un parche limpio.
- `docs/mapa-de-ficheros.md` — 9 afirmaciones ROJAS → corrección = regenerar todo el árbol (804 líneas).
- `docs/directiva-ficheros-del-agente.md` — 2 afirmaciones ROJAS (`app.ts:41:1483` y tenant confusión).
- `docs/terminal-pty.md` — 1 afirmación ROJA (`./scripts/rollback.sh`).
- `docs/adr/006-agent-registry-and-deferred-execution.md` — 1 afirmación ROJA (`docs/POOL-SUSCRIPCIONES-Y-ALTA-AGENTES.md`).
- `docs/grafo.md` — 2 ROJAS (cifras obsoletas, regenerables con `pnpm grafo`).

Recomiendo al integrador / Claude aplicar el lote en una sola ronda, no en commits separados por línea, para no envenenar más al árbol. La Tarea 1 de mi orden (`mapa-de-ficheros.md` refresco total) ya está en `ordenes/opencode-minimax.md` y absorbe la regeneración del mapa; la Tarea 2 (este informe) consume el resto de docs.

## Resto (NO tocados, solo reportados — sector ajeno)

- `README.md` (raíz), `AGENTS.md`, `PENDIENTES-DEL-DUEÑO.md` — sector del dueño / integrador.
- `console/README.md` — sector Gemini.
- `services/{gateway,dispatcher,terminal-relay,telegram-bridge}/README.md` y `CONFIGURATION.md` — sector Codex.
- `packages/{protocol,store,adapter-sdk,mcp-fleet-monitor}/README.md` — sector Codex.
- `ops/README.md`, `ops/INSTALLATION.md`, `ops/GATE_CONTRACT.md` — sector Claude / Codex / dueño.
- `ops/runbooks/*.md` (17 ficheros) — sector Claude.
- `ordenes/{00-PROTOCOLO,codex,gemini,opencode-minimax}.md` — sector Claude / dueño.

## Notas finales

- Las cifras "que el código contradice directamente" (ROJO) son de TIPO 1 y de TIPO 2: TIPO 1 = `find` falla (fichero renombrado o retirado — p. ej. `legado-candidato.ts`, `dlq-*.py`, `scheduler.ts`); TIPO 2 = el fichero existe pero su contenido es ahora una partición/barrel y la cifra de líneas apunta al lugar equivocado.
- Las afirmaciones métricas (líneas, bytes, refs) sin verificación dinámica son **frágiles por naturaleza**: cualquier split o merge las invalida en horas. La regeneración determinista (`pnpm grafo`, `scripts/grafo.mjs`, `scripts/calidad.mjs`) es la única defensa durable, y `docs/grafo.md` lo dice en su cabecera — basta con ejecutarlo tras la ronda.
- No hay nada en este censo que requiera PARAR el lanzamiento: las afirmaciones rotas son de navegación/cifras, no de contratos. El único ROJO con potencial de acción accidental es `docs/terminal-pty.md:256` (`./scripts/rollback.sh` no existe) — si alguien lo ejecuta en producción simplemente falla, pero la intención del párrafo es el procedimiento real (`ops/scripts/pin-container-release.py rollback`).
