# Bitácora (histórico congelado)

Material histórico: handoffs, informes de sesión, planes fechados, runbooks retirados, **y** las órdenes de cada ronda ya ejecutadas. **No es estado actual del sistema** — no confiar en nada de aquí como verdad vigente. El estado vigente vive en el README raíz, `docs/arquitectura.md`, `plan-reestructura/` y `ordenes/{00-PROTOCOLO,codex,gemini,opencode-minimax}.md`.

Las fechas entre paréntesis son del nombre del fichero cuando lo lleva, o `—` si no. La columna "qué es" es una sola línea por fichero.

**Doctrina sobre código muerto (desde `73e533c`):** se borra con `git rm` + evidencia en el commit; no existen carpetas de cuarentena. El índice de lo retirado vive en `legado-indice.md` y se recupera con `git log --diff-filter=AD` o el bundle del 27-08.

## Índice

| Fichero | Fecha | Qué es |
|---|---|---|
| `COHERENCIA-FLOTA-2026-07-25.md` | 2026-07-25 | Informe de coherencia: harnesses declarados vs. ejecutados, gate-snapshot-collector, zombies de kratos/agora-storage. |
| `HANDOFF-HARNESS-RENEWAL-2026-07-24.md` | 2026-07-24 | Handoff de renovación durable del harness + ejercicio Prometeo; declaraba commits `842d42b`/`9dfb79d`/`7d4c154`. |
| `POOL-SUSCRIPCIONES-Y-ALTA-AGENTES.md` | — | Plan ejecutable del pool de suscripciones IA y alta de agentes; verificado contra el código de aquel entonces. |
| `consola-e2e-2026-07-26.md` | 2026-07-26 | Barrido E2E de las 12 áreas de la consola: 12 bugs/degradaciones confirmados (4 medio, 8 bajo). |
| `consola-rama-fuera-de-main.md` | — | Incidente de rama larga de consola y el camino histórico de release retirado (tombstones fail-closed). |
| `consultas-grafo.sql` | 2026-08-22 | Consultas del grafo de agentes probadas contra `cauce-v3-prod-postgres-1` con EXPLAIN al pie. |
| `deploy.md` | — | Runbook de deploy aislado (build con RepoDigest, productores de imagen, selectores). Maquinaria superada. |
| `directiva-lectura-de-gobierno-20260825.md` | 2026-08-25 | Caso histórico sanitizado: el modal de directiva leía rol pero no mostraba gobierno/memoria. |
| `dlq-causal-reconciliation.md` | — | Diseño y garantías de la migración 030 (reconciliación causal de DLQ vía `telegram_exact_sent_v1`). |
| `dual-stack-shadow-pilot.md` | — | Plan dual-stack + shadow + cutover progresivo de 15 agentes (V2 autoritativo durante shadow). |
| `handoff-codex-directiva-20260825.md` | 2026-08-25 | Traspaso de zeus a codex sobre el editor de perfiles de agente (modal «Directiva»), mergeado en `9862d1f`. |
| `handoff-zeus-20260824.md` | 2026-08-24 | Handoff operativo histórico sanitizado: modal que mostraba metadatos pero no el contenido de la directiva. |
| `hardening-2026-07-25.md` | 2026-07-25 | Runbook accionable de hardening: backups ut-nexus, Prometheus→Telegram, watchdog de contenedores, TLS. |
| `manual-del-medico.md` | — | "Manual del médico de la flota": diagnóstico y reparación de fallos Cauce V3 (las señales mienten, comprobar el efecto). |
| `migration-integrity.md` | — | Integridad de migraciones: `024_agent_role_templates` puede figurar aplicada sin fuente; gate vuelve a medir. |
| `migration-plan.md` | — | Plan "Shadow V2 → V3 sin tocar servicios vivos": baseline V2 read-only, V3 aislado, cutover explícito por alias. |
| `pendientes-2026-07-25.md` | 2026-07-25 | Corte de pendientes 23:00 UTC; los `done` de los agentes no prueban ejecución (Kant inventaba respuesta). |
| `queues-contadores-2026-07-26.md` | 2026-07-26 | Contadores de queues: el bug tiene dos capas (seguimiento del hallazgo #2 del E2E de consola). |
| `rollback.md` | — | Runbook de rollback (lectura de selectores desde `CAUCE_ENV_FILE`, sin bajar migraciones). Maquinaria superada. |
| `salva-bwrap-namespace-fix.md` | — | Runbook: el adapter `salva` fallaba con `bwrap: No permissions to create a new namespace` al ejecutar `codex`. |
| `sesion-compartida-tmux.md` | — | Piloto de sesión compartida: la TUI real del harness y el bus de Telegram, una sola conversación. |
| `tmux-sesion-real.md` | — | Terminal real + Telegram, una sola conversación: el comando `cauce <alias>` abre el binario del harness. |
| `superpowers/plans/2026-07-24-provider-smoke-contract-repair.md` | 2026-07-24 | Plan superpowers: reparar el contrato del workflow `provider-smoke` para aceptar IDs canónicos de modelo. |
| `superpowers/specs/2026-07-24-provider-smoke-contract-design.md` | 2026-07-24 | Diseño (approved) del fix anterior: normalizar `providers` antes del quota resolver, preservar 10 rutas canónicas. |
| `legado-indice.md` | 2026-08-27 | Índice de lo retirado del árbol (borrado en `73e533c`, 3.2M). `_legado/` ya no existe; este doc conserva la lista de 25 ops-scripts + 6 schemas + 2 servicios + rollback-bridge + 52 contingentes + 33 tests con la subruta espejada y la receta de recuperación por `git log --diff-filter=AD` o el bundle del 27-08. |
| `ordenes-ejecutadas/ronda1/` | 2026-08-26 | Primera tanda: bootstrap del protocolo, censo de la cuarentena, partición inicial del store. 3 ficheros (`codex.md`/`gemini.md`/`opencode-minimax.md`). |
| `ordenes-ejecutadas/ronda2/` | 2026-08-26 | Segunda tanda: CI mínima, runbooks, vistas sin uso de consola, limpieza del repo. 3 ficheros. |
| `ordenes-ejecutadas/ronda3/` | 2026-08-26 | Tercera tanda: 4 subagentes de codex (regex, fanin, parche opaco, health) + carpintería de consola. 3 ficheros. |
| `ordenes-ejecutadas/ronda4/` | 2026-08-27 | Cuarta tanda: descontaminación — 29 muertos confirmados por doble ejecución (Codex). 3 ficheros. |
| `ordenes-ejecutadas/ronda5/` | 2026-08-27 | Quinta tanda: consola 107/107, particiones de pty-session/OperatorWorkspace/live.css, hash de migraciones. 2 ficheros (`codex-terra.md`/`opencode-minimax.md`). |
| `ordenes-ejecutadas/ronda6/` | 2026-08-27 | Sexta tanda: cierre de inequívocos — 6 schemas, 5 tests huérfanos, 4 scripts, ops/harness huérfano, reescritura del censo de dudosos. 3 ficheros (`gemini.md`/`gemini-consola.md`/`opencode-minimax.md`). |
| `ordenes-ejecutadas/ronda7/` | 2026-08-27 | Séptima tanda (esta): docs al día + foto final; `_legado/` ya borrado por `73e533c`. 1 fichero (`opencode-minimax.md`). |