# Mapa de ficheros — qué hace cada uno en este repo

Generado el 2026-08-27 con 4 subagentes en paralelo (MiniMax Tarea 2); refrescado el 2026-08-27 (MiniMax Tarea 1 ronda 4).
Total ficheros en repo (`git ls-files`): **1278**. Tests independientes en la sección final.

**⚠** al final de la línea = el nombre del fichero miente sobre su contenido (señalado por el subagente tras leer el código).
Total de marcadores ⚠ en todo el documento: **3** (reducidos desde 8 al retirar la familia DLQ manual; ver delta abajo).

**Sector dueño** sigue el reparto del protocolo (`ordenes/00-PROTOCOLO.md` §`Convivir en main`): Codex para store/gateway/adapter-sdk/protocol/mcp, Gemini para console/canales, Claude+FASE 3 para PTY/contenedores/manifests, MiniMax para docs/higiene.

Cobertura por grupo (verificada con `git ls-files` 2026-08-27):
- A. packages/ (326) — protocol, store, adapter-sdk, mcp-fleet-monitor — Codex
- B. services/ (191) — gateway, dispatcher, terminal-relay, telegram-bridge — Codex + Gemini
- C. console/ + scripts/ + vitest.config.ts (319 + 7) — Gemini + Codex
- D. ops/ + deploy/ (239 + 31) — Codex + Claude+FASE 3 + DUEÑO
- E. tests/ (89) + tests bajo `*/test/` y `*/tests/` — repartidos por sector

Hallazgos del ensamblado:
- **1** entrada del subagente apuntaba a un path que no existe en `git ls-files` — descartada (probable alucinación: `console/src/features/terminal/SessionStage.test.tsx`).
- **1** entrada duplicada dentro de la misma sección — descartada.
- **6** entradas de la ronda anterior referencian paths que YA NO EXISTEN (familia DLQ manual retirada por codex + rutas renombradas) — corregidas en este refresco (ver §`DELTA 2026-08-27`).
- Co-localización: muchos tests viven junto a su código bajo `src/` (p. ej. `services/gateway/src/*.test.ts`, `console/src/**/*.test.tsx`) y están listados en su grupo (A–D). Los tests independientes bajo directorios `test/` van en la sección E.

Notas metodológicas:
- Los subagentes LEYERON cada fichero (no infirieron del nombre). Las descripciones son verificables abriendo el fichero.
- Las cifras entre paréntesis son las subtotales por directorio, recalculadas tras descartar duplicados/hallucinations.

## DELTA 2026-08-27 (refresco MiniMax ronda 4)

Cambios desde la versión del 2026-08-27 inicial (mini-exhaustivo, no exhaustivo — el documento conserva todas las descripciones que seguían siendo ciertas):

**Retiradas (ficheros citados que ya NO existen en `git ls-files`):**
- `apps/console/**` — el árbol viejo desapareció; renombrado a `console/` raíz en commit `0c965d1`. Las descripciones siguen siendo válidas bajo `console/`.
- `services/gateway/src/routes/legado-candidato.ts` + `.test.ts` — renombrado a `chain-gates-legado.ts` + `.test.ts` (97 líneas, registra `registerLegacyCandidateChainGateRoutes` gated por `enableLegacyCandidateRoutes`).
- `services/dispatcher/src/scheduler.ts` — refactorizado; la alternancia interactive/batch vive ahora en `packages/store/src/repository/jobs.ts` (`job_lane_fairness`).
- `ops/scripts/dlq-list.py`, `dlq-reconcile.py`, `dlq_cli.py`, `resolve-dlq-without-replay.py`, `telegram-manual-replay.py`, `telegram-replay-inspect.py` — toda la familia DLQ manual retirada por codex (ver `ordenes/codex.md`). Esto explica la caída de 8 a 3 en los marcadores ⚠.
- Migraciones `029_*` y `036_*` — borradas con toda su maquinaria física (manifests, units, historicalAliases). El mapa no las citaba, pero `docs/arquitectura.md` sí las mencionaba.

**Adiciones (paths nuevos en `git ls-files` aún no descritos — descripciones tomadas de `head -30` por el subagente de refresco):**

*A. packages/*:
- `packages/store/src/repository/_hash-to-uuidv7.ts` — `hashToUuidV7` (mapping determinista de sha256→UUID v7 ordenable).
- `packages/store/src/repository/egress-destinations.ts` — derivación de destinos de egress proactivo desde el profile del agente (allowlist + cross-tenant guard).
- `packages/store/src/repository/agents/chain-control/materialization.ts` — materialización durable de la cadena de delegación (separada de `chain-control.ts`).
- `packages/store/src/repository/agents/chain-control/policy.ts` — `chainPolicy` (hop budget, fanout cap, edge cap, root budget, gate humano, `@all` expansion).
- `packages/store/src/repository/messages/{contracts,publishing,receipts}.ts` — partición de `repository/messages.ts` en tres: contratos, flujo publish durable, recibos.
- `packages/store/src/repository/observability/{chain-sweep,contracts,helpers,maintenance}.ts` — partición de `observability.ts` (sweep de cadenas mudas, tipos, helpers, mantenimiento).
- `packages/store/src/repository/outbox/{claims,contracts,operator,origin-relay,settlement}.ts` — partición de `outbox.ts` (claims con fence, contratos, operator, origin-relay, settlement).
- `packages/store/src/repository/config/publish-policy.ts` — `publishPolicy` (human band vs agent ceiling; cross-check con `publish-priority-policy` del gateway).
- `packages/adapter-sdk/src/shared-session/session/identity.ts` — identidad de sesión separada del módulo `session.ts` (huella de pane + nonce).
- `packages/protocol/src/outbox-contracts.ts` — contratos Zod del outbox (cross-checks con `publish-receipt`).

*B. services/*:
- `services/gateway/src/console/agent-documents/{catalog,path-policy,relay-probe}.ts` — partición de `agent-documents.ts` (catálogo de docs gobernados, política de paths, probe del relay).
- `services/gateway/src/terminal/relay-proxy/{authorization,close,consume,context,presence,resume}.ts` — partición del proxy relay (antes monolitico en `relay-proxy.ts` de 23 líneas — el barrel reexporta).
- `services/gateway/src/terminal/session-control/targets.ts` — `targetSpecs` para el control de sesión (issuance/rotation/revocation).
- `services/gateway/src/routes/chain-gates-legado.ts` + `.test.ts` — antes `legado-candidato.{ts,test.ts}`.
- `services/gateway/src/routes/console-publish.ts` — ruta dedicada a publish de consola (extraída de `routes/console.ts`).
- `services/gateway/src/routes/console/{contracts,early,helpers,phase4}.ts` — partición de `routes/console.ts` (contratos, early-access, helpers, phase 4).
- `services/gateway/src/routes/core/{contracts,helpers,http,outbox,publish}.ts` — partición de `routes/core.ts` (628 líneas → 5 módulos = 878 líneas).

*C. scripts/*:
- `scripts/guardia-no-root.mjs` — guardia que aborta si se ejecuta como root (los tests unitarios deben correr como usuario normal).

**Cifras de líneas con desviación >20% respecto a las citadas:**
- `services/gateway/src/routes/core.ts`: el mapa decía 1 sola entrada; en realidad es 628 líneas + 5 ficheros hermanos (878 líneas).
- `packages/store/src/repository.ts`: el mapa lo lista pero el módulo se ha ampliado enormemente con `repository/{agents,config,deliveries,messages,observability,outbox}/*`.
- `packages/store/src/repository/observability/ (1x)`: ahora son 5 ficheros; el mapa solo cita `policy.ts`.
- `services/terminal-relay/src/agent-leg.ts`: citado como 1065 líneas en `docs/arquitectura.md` (fuera de mi sector; corregir al integrador), pero son 206 reales.
- `dispatcher/src/scheduler.ts`: 0 líneas (no existe); el mapa aún lo cita.

## A. packages/ (protocol, store, adapter-sdk, mcp-fleet-monitor)

### packages/protocol/ (7x)
- packages/protocol/src/agent-profile.ts — tipos `AgentProfile`, `HechosDelAlias`, `ContextoDeAlias`, validación/normalización de perfiles de agente y composición del bloque Markdown (`componerBloqueDePerfil`) — Codex (protocol)
- packages/protocol/src/ficheros-del-arnes.ts — reparte las secciones del perfil entre CLAUDE.md, AGENTS.md y los siete ficheros de openclaw (SOUL/IDENTITY/USER/MEMORY/HEARTBEAT/AGENTS/TOOLS), con topes de tamaño por fichero y total — Codex (protocol)
- packages/protocol/src/index.ts — barrel que reexporta los seis módulos del paquete — Codex (protocol)
- packages/protocol/src/marcas-de-bloque.ts — utilidades para insertar/extraer/quitar bloques delimitados por marcas HTML `CAUCE:CONTEXTO-FIJO` y `CAUCE:PERFIL` en ficheros del arnés — Codex (protocol)
- packages/protocol/src/priority.ts — bandas de prioridad (techo de agente 50, piso humano 60, prioridad humana 70) y `clampAgentPriority` — Codex (protocol)
- packages/protocol/src/publish-receipt.ts — hashes canónicos del contrato de idempotencia (`publishRequestHash`, `publishReceiptCausalHash`, `consolePublishIntent*Hash`) y `buildPublishReceipt` — Codex (protocol)
- packages/protocol/src/schemas.ts — esquemas Zod del wire 3.0 completo (publish, ack, delivery envelope, configuración, cuotas, agentes a agente, delegaciones), códigos de error ambiguos/preflight, constantes y tipos derivados — Codex (protocol)

### packages/store/src/ (13x)
- packages/store/src/accounts.ts — `selectAccountForAlias` para elegir la cuenta óptima por prioridad y `AUTO_PAUSE` al detectar cuota agotada con horizonte de reset — Codex (store)
- packages/store/src/agent-profile.ts — `AgentProfileRepository` (lectura/escritura de `agent_profiles` con CAS por revisión, `markApplied` para ACK de runtime, `readContext` consolidando permisos+cuotas+arnés+destinos) — Codex (store)
- packages/store/src/audit-summary.ts — `safeAuditSummary` que produce JSON saneado y positivo/allowlisted del metadata de auditoría para la consola — Codex (store)
- packages/store/src/configuration.ts — `ConfigurationRepository` (apply/rollback de mutaciones sobre todas las tablas de configuración con revisión optimista, auditoría y `dry_run`) — Codex (store)
- packages/store/src/db.ts — pool de node-postgres, `withTransaction`/`withAbortableTransaction` (cancela backends PostgreSQL), `applyMigrations`, suscripción LISTEN/NOTIFY para wakes de entrega — Codex (store)
- packages/store/src/delegation-guard.ts — `sanitizedDelegationCaps`, `fanoutCapForTurn` y `describeDelegationRejection` (catálogo de motivos de rechazo de delegación con texto humano legible) — Codex (store)
- packages/store/src/fleet-activity.test.ts — Vitest del heurístico `agentWorkState` con los cuatro casos canónicos del panel — Codex (store)
- packages/store/src/fleet-activity.ts — `agentWorkState` (estado y flags de trabajo de un agente) y `FLEET_ACTIVITY_QUERY` (la consulta SQL agregada para GET /v3/console/activity) — Codex (store)
- packages/store/src/index.ts — barrel del paquete `@cauce/store` — Codex (store)
- packages/store/src/migrate-cli.ts — entrypoint one-shot para aplicar migraciones, gateado contra NODE_ENV y entrypoint del deploy — Codex (store)
- packages/store/src/migration-integrity.ts — `inspectMigrationIntegrity` (fingerprint canónico de 024 + ledger atómico de fuente para migraciones posteriores) — Codex (store)
- packages/store/src/repository.quota-schema-version.test.ts — Vitest que valida el rechazo temprano de `schema_version` no soportado sin tocar Postgres — Codex (store)
- packages/store/src/repository.ts — barrel que reexporta tipos del repositorio y declara `CauceRepository extends QuotasRepository` (la clase vacía) — Codex (store)

### packages/store/src/repository/ (10x)
- packages/store/src/repository/agents.ts — `AgentsRepository` (presencia de adaptadores, adopción de runtime profile, `routingTargets`, `selfRoleFromProfile`, listado de agentes/adapter) — Codex (store)
- packages/store/src/repository/base.ts — `BaseRepository` abstracto (guarda `pool` y declara `assertPermission` por `route|read|control|notify`) — Codex (store)
- packages/store/src/repository/config.ts — `ConfigRepository` (autorización, `getConfiguration`/`applyConfigurationChange`/`rollbackConfiguration`, topología, selección de cuenta, constantes y helpers del journal durable de intents de publish de consola) — Codex (store)
- packages/store/src/repository/deliveries.ts — barrel que reexporta tipos y constantes de `deliveries/contracts` y expone `DeliveriesRepository` como `extends DeliveryAcksRepository` — Codex (store)
- packages/store/src/repository/errors.ts — `StoreError` y `StoreErrorCode` (forbidden|no_route|conflict|fenced|not_found|invalid_actor|invalid_input|rate_limited) — Codex (store)
- packages/store/src/repository/jobs.ts — `JobsRepository` (enqueue, claim con SKIP LOCKED, alternancia interactivo/batch con `job_lane_fairness`, complete/fail, `retryExpiredJobs`, list) — Codex (store)
- packages/store/src/repository/messages.ts — `MessagesRepository` (publish durable con idempotencia, prepare/confirm/reconciliation de console publish intent, getMessage/listMessages, reconstructPublishReceipt) — Codex (store)
- packages/store/src/repository/observability.ts — `ObservabilityRepository` (`retryStaleDeliveries` reaper, `pruneObservability`, `sweepSilentChains`, retención; exporta `DeliveryRow`, `ChainPolicy`, helpers `agentDeploymentStatus`/`truncateUtf8`) — Codex (store)
- packages/store/src/repository/outbox.ts — `OutboxRepository` (`insertOriginRelay`, `claimOutbox`/`claimWakeOutbox` con fence por sesión, `renewWakeOutbox`, `ackOutbox`, `replayDelivery`, `cancelDelivery`, autorización de replay, helpers de texto visible) — Codex (store)
- packages/store/src/repository/quotas.ts — `QuotasRepository` (`quotaSnapshot` con sparkline 24h y severidad, `recordQuotaSample` con ingesta, auto-pausa y auto-resume de cuentas) — Codex (store)

### packages/store/src/repository/agents/ (7x)
- packages/store/src/repository/agents/chain-control.ts — `AgentChainControlRepository` (`loadChainPolicy` con degradación en despliegue parcial, `materializeAgentOutputs` con hop budget, fanout, edge cap, root budget, gate humano, `@all` expansion, materialización durable de delegaciones) — Codex (store)
- packages/store/src/repository/agents/fanin.ts — `AgentFaninRepository` (`failureNoticeDetail` con visibilidad default-deny cross-tenant, `agentChain` topología en vivo de la cadena de delegación) — Codex (store)
- packages/store/src/repository/agents/fanin/helpers.ts — constantes (`agentFaninInstruction`, `progressRelayCappedText`), `chainNode`, `opaqueNodeId`, helpers `agentResponseRequestId`, `agentResponseText`, `failureSignature`, `aggregatedFailureText` — Codex (store)
- packages/store/src/repository/agents/fanin/materialization.ts — `AgentFaninMaterializationRepository` (`materializeAgentFanin` con advisory lock por raíz, agregación de respuestas de hijos, agendamiento del fan-in) — Codex (store)
- packages/store/src/repository/agents/fanin/progress.ts — `AgentProgressRepository` (`insertProgressRelay` relay de progreso no-terminal a Telegram con cap por raíz y aviso de cierre) — Codex (store)
- packages/store/src/repository/agents/fanin/response.ts — `AgentResponseRepository` (`materializeAgentResponse` para la rama agent.response/agent.fanin que sube hacia el padre) — Codex (store)
- packages/store/src/repository/agents/notifications.ts — `AgentNotificationsRepository` (decide allow/deny del egress proactivo por handle, dry-run con rollback, límites, `kind`, `prior_contact`, quiet hours) — Codex (store)

### packages/store/src/repository/deliveries/ (4x)
- packages/store/src/repository/deliveries/acks.ts — `DeliveryAcksRepository` (`ackDelivery` con fence de exclusividad, lease cap, integración de feedback de delegación, replay de resultado tardío, ACK tras reap) — Codex (store)
- packages/store/src/repository/deliveries/claims.ts — `DeliveryClaimsRepository` (`acquireLease` con takeover/resume, capacidad declarada del agente, claim de entregas con respeto al cupo humano) — Codex (store)
- packages/store/src/repository/deliveries/contracts.ts — tipos `AckResult`, `OpenChainGate`, `LeaseResult`, constantes (`maxAgentOutputMessages`, `maxNotifyBodyBytes`), parsers `agentOutputEntries`/`agentNotifyEntries` y `sanitizeProcessOutput` equivalente para la salida del arnés — Codex (store)
- packages/store/src/repository/deliveries/control.ts — `DeliveryControlRepository` (`cancelDelivery` operador, motivo con prefijo estable,Dead Letter y relay al origen) — Codex (store)

### packages/store/src/repository/observability/ (1x)
- packages/store/src/repository/observability/policy.ts — políticas de retención (ACK/audit/renovaciones), `deliveryLeaseCapMs`, `leaseCapMsSql`, `DISPOSABLE_AUDIT_ACTIONS` (lista blanca), `timeoutRetryBackoffSeconds` — Codex (store)

### packages/mcp-fleet-monitor/ (5x)
- packages/mcp-fleet-monitor/demo-client.mjs — cliente Node mínimo que arranca el servidor MCP por stdio y le hace requests JSON-RPC para los tools del monitor — Codex (mcp-fleet-monitor)
- packages/mcp-fleet-monitor/src/fleet-read-model.test.ts — Vitest con `scriptedPool` (pool doble determinista) que cubre mapeos y selectores del read model — Codex (mcp-fleet-monitor)
- packages/mcp-fleet-monitor/src/fleet-read-model.ts — `FleetReadModel` (read model contra `@cauce/store` para `estadoFlota`, `entregasActivas`, `cadenaActiva`, `estadoAdaptadores`, etc.) — Codex (mcp-fleet-monitor)
- packages/mcp-fleet-monitor/src/index.ts — barrel que sólo reexporta `FleetReadModel` — Codex (mcp-fleet-monitor)
- packages/mcp-fleet-monitor/src/server.ts — servidor MCP stdio (`Server` de `@modelcontextprotocol/sdk`) que envuelve `FleetReadModel` como tools: `estado_flota`, `entregas_activas`, `topologia_cadena`, `estado_cuentas`, `estado_adaptadores` — Codex (mcp-fleet-monitor)

### packages/adapter-sdk/ (88x)
- packages/adapter-sdk/bridge/hermes-stdin-bridge.py — puente Python one-shot para Hermes (lee el prompt por stdin con tope 1 MiB, llama a Hermes, decodifica los logs nativos sin que lleguen a argv/stdout del wrapper) — Codex (adapter-sdk)
- packages/adapter-sdk/bridge/openclaw-stdin-bridge.mjs — puente Node one-shot para OpenClaw (lee el prompt por stdin, deriva la clave de sesión, serializa el proceso y captura la respuesta estructurada) — Codex (adapter-sdk)
- packages/adapter-sdk/scripts/chmod-bins.mjs — pone 0o755 a los ocho binarios de `dist/src/bin/*.js` tras el build — Codex (adapter-sdk)
- packages/adapter-sdk/scripts/copy-bridges.mjs — copia `hermes-stdin-bridge.py` y `openclaw-stdin-bridge.mjs` a `dist/bridge/` con modo 0o755 — Codex (adapter-sdk)
- packages/adapter-sdk/scripts/package-smoke.mjs — `npm pack --dry-run --json` que asegura que ambos puentes lleguen ejecutables al tarball publicado — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/claude.ts — entrypoint de 4 líneas: `runCli("claude").catch(reportFatal)` — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/codex.ts — entrypoint de 4 líneas: `runCli("codex").catch(reportFatal)` — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/config.ts — `loadCliRuntimeConfig` (lee alias/runtime desde `--config FILE` o de variables `CAUCE_*`, rechaza secretos en línea y exige credenciales por path) — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/fake-harness.ts — binario Node de 22 líneas que lee prompt por stdin y emite JSON de harness fake según la marca `SCENARIO:` (timeout/malformed/fail/retry) — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/fake.ts — entrypoint de 4 líneas: `runCli("fake").catch(reportFatal)` — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/hermes.ts — entrypoint de 4 líneas: `runCli("hermes").catch(reportFatal)` — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/openclaw.ts — entrypoint de 4 líneas: `runCli("openclaw").catch(reportFatal)` — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/opencode.ts — entrypoint de 4 líneas: `runCli("opencode").catch(reportFatal)` — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/shared-session.ts — CLI `ensure|status|degradations` para inspeccionar/asegurar la sesión tmux compartida de un alias — Codex (adapter-sdk)
- packages/adapter-sdk/src/bin/shared.ts — `runCli(harnessId)` (carga config, deriva `SharedSessionSpec`, abre la tienda durable, siembra perfil, conecta WS, ejecuta el `AdapterEngine`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/context/perfil-a-contexto.ts — `compilarContexto` (perfil + hechos → bloque Markdown), `proyeccionOpenclaw` (sub-árbol JSON determinista para fusionar), `rolBreveDelPerfil`, `serializarEstable` — Codex (adapter-sdk)
- packages/adapter-sdk/src/context/siembra-del-perfil.ts — escribe los ficheros del arnés (CLAUDE.md/AGENTS.md/etc.) con escritura atómica y renombrado; nunca lanza, devuelve un `ResultadoDeLaSiembra` diagnóstico — Codex (adapter-sdk)
- packages/adapter-sdk/src/fake-harness.ts — `FakeHarness` (EventEmitter que implementa el lado adaptador para tests: WS, hello, ack con `execution_started`, heartbeat, waitFor por predicado) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/bridge-paths.ts — dos líneas: exporta `HERMES_BRIDGE_PATH` y `OPENCLAW_BRIDGE_PATH` como `fileURLToPath` resueltos contra `dist/bridge/` — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/claude.ts — `claudeDefinition` (`HarnessDefinition` con `command: "claude"`, args, sessionStrategy `generated`, parser `parseClaudeOutput`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/codex.ts — `codexDefinition` (`exec --skip-git-repo-check`, sesión `observed`, `startWitness` por primer byte de stdout, parser `parseCodexOutput`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/contexto-fijo.ts — gestión del sello `sha256` del bloque fijo; `sembrarContextoFijo`, `motivoDeReenvio`, `renglonDeContextoFijo`, `rutaDelContextoFijo` para claude/codex — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/fake.ts — `fakeDefinition` que envuelve `cauce-fake-harness` con `parseDirectOutput` — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/hermes.ts — `hermesDefinition` (`python3` + puente, `startWitness` por marca en stderr, sesión `none`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/index.ts — `HARNESS_DEFINITIONS` (mapa de los seis arneses) y `harnessDefinition(id)` — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/openclaw.ts — `openClawDefinition` (invoca el puente Node en proceso, capacidades `loopback_api`/`stable_alias_sessions`/`api_cancellation: "abort_signal"`, parser `parseOpenClawOutput`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/opencode.ts — `openCodeDefinition` (`opencode run --format json --attach http://127.0.0.1:4097 --dir /workspace/kant`, sesión `observed`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/shared.ts — barrel que reexporta `HarnessAdapter` (clase), helpers de error y los textos fijos (`IDENTITY_BEGIN/END`, `protocolPrompt`, `textoFijoDelSobre`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/shared/adapter.ts — `HarnessAdapter` (clase: reserva sesión, ejecuta el arnés con su `process-runner`, parchea `prompt` con sello/contexto, materializa adjuntos, valida JSON, publica al store) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/shared/attachments.ts — `planAttachments` (elige entrega nativa vs filesystem_fallback por arnés y mime) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/shared/contracts.ts — tipos `HarnessRequestContext`/`HarnessAdapterOptions`/`HarnessSessionReservation`/`RuntimeProfileMeasurement`/`HarnessExecuteRequest` — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/shared/errors.ts — clasificación de errores (`nuncaEmpezoElTurno`, `esDiagnosticoDeArranque`, `abortadoPorApagado`), `sinMarcaDeArranque` y `sanitizeProcessOutput` con regex de secretos (ANTHROPIC_API_KEY, Bearer, URLs con credenciales, JWT, PEM) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/shared/prompt.ts — `capabilities(harnessId, persistent)` (lista de caps declaradas), `protocolPrompt`/`textoFijoDelSobre` (literal obligatorio: deber primario, mecánica de delegación, identidad) — Codex (adapter-sdk)
- packages/adapter-sdk/src/harnesses/shared/session-reservation.ts — `SessionReservation` (encapsula la espera de turno de la sesión compartida con `wait(signal)` y `release()`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/index.ts — barrel público del paquete `@cauce/adapter-sdk` (re-exporta sdk/*, context/*, harnesses/index, shared-session/index y las constantes de ficheros de arnés de `@cauce/protocol`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/account-credentials.ts — `resolveCredentials` de la respuesta del selector de cuentas del gateway a variables de entorno del arnés cuando `CAUCE_ACCOUNT_ROTATION=enabled` — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/artifact-inliner.ts — convierte adjuntos locales del output en URIs `data:` base64, respeta el tope agregado y bloquea `/proc`/`/sys`/`/dev` — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/attachments.ts — `materializeAttachments` (escribe el base64 del sobre a disco y devuelve `HarnessAttachment` con sha256+path), allowlist MIME simétrico con el protocolo — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/backoff.ts — `ExponentialBackoff` con `DEFAULT_BACKOFF` (250ms → 30s, factor 2, jitter 20%) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/client.ts — `AdapterClient` (orquesta el connector WS, `DurableStore`, harness y `AdapterEngine`; maneja hello/reconexión/backoff) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store.ts — `DurableStore` (raíz de la jerarquía) + barrel de constantes (`ATOMIC_STATE_FILES`, `MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store/atomic-state.ts — primitivas atómicas del store local (`clone`, `readJson`, `atomicWrite` con fsync+rename, `recoverAtomicArtifacts`, `prepareStateDirectory`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store/base.ts — `DurableStoreBase` (memoria para inbox/outbox/sessions/fencing, `serialized` para escribir de forma serializada) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store/consumer-lease.ts — `ConsumerLease` (lock file por alias para impedir dos adaptadores en el mismo `$STATE_DIR`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store/contracts.ts — tipos `InboxRecord`/`OutboxFile`/`FencingFile`/`SessionsFile`/`AtomicStateFile` y constantes (límite de delegaciones retenidas, ventanas de timers) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store/deliveries.ts — `DurableStoreDeliveries` (`accept`/`start`/`finish`/`renew`/`captureEvent`/`markStarted`, transición de estados de inbox con fence por epoch) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store/delivery-helpers.ts — `lifecycleSlot`, `lifecycleEventFor`, `deliveryFingerprint` (hash estable para reclamar el evento duplicado) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store/fanin.ts — `DurableStoreFanin` (bookkeeping local de respuestas de fan-in: registra branch identity, branch progress) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store/session-file.ts — `readSessionsSecure`/`validateSessionsFile` (rechaza claves JSON duplicadas, valida paths, esquema seguro) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/durable-store/sessions.ts — `DurableStoreSessions` (`getSession`/`setSession`, manejo de sesiones canónicas opencode/openclaw) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/engine.ts — `AdapterEngine` (corazón del adaptador: accept → reservar sesión → invocar arnés → parsear output → publicar ACK → recuperación tras crash) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/engine/contracts.ts — tipos y constantes del motor (`DEFAULT_AGENTIC_TIMEOUT_MS=24h`, `MAX_AGENT_EXECUTION_TIMEOUT_MS=7d`, `DEFAULT_QUEUE_WAIT_TIMEOUT_MS=6h`, `EventPublisher`, `ExecutionIntentPublisher`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/engine/delivery-context.ts — deriva `sessionKey`/`sessionLane`/`sessionOrigin` por scope de la entrega — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/engine/recovery.ts — `interruptedStartedError` (distingue `INTERRUPTED_PREFLIGHT` con `execution_intent_receipt_event_id` de `INTERRUPTED_AMBIGUOUS` legado) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/engine/system-gate-probe.ts — maneja el body reservado `system.gate.probe` (termina el claim sin harness, sin modelo, sin reply) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/errors.ts — jerarquía `AdapterError` con códigos (MALFORMED_OUTPUT, EXECUTION_FAILED, STALE_EPOCH, CONSUMER_LEASE, SHUTDOWN, etc.) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/fanin-synthesizer.ts — `synthesizeFaninOutput` (compone la respuesta final de fan-in con atribución por tenant/alias, truncando por bytes y descartando entradas vacías) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/openclaw-api-runner.ts — `OpenClawApiRunner` (ejecuta OpenClaw vía HTTP loopback con cancelación por `AbortSignal` y bearer token de un archivo) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/output-parser.ts — barrel del parser (exporta `parseClaudeOutput`/`parseCodexOutput`/`parseDirectOutput`/`parseHermesOutput`/`parseOpenClawOutput`/`parseOpenCodeOutput` y `validateDeliveryOutput`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/output-parser/contract.ts — constantes `MAX_FINAL_TEXT_BYTES=64KiB`, `MAX_RELAY_MESSAGES=100`, `validateStructuredOutput`/`validateDeliveryOutput` y `hasVisibleText` — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/output-parser/envelopes.ts — `parseFinalText`, `parseCandidate`, detección de status nativos de fallo (`error`/`failed`/`timeout`/`aborted`...), fence stripping de JSON — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/output-parser/harnesses.ts — parsers por arnés (`parseClaudeOutput`/`parseCodexOutput`/`parseHermesOutput`/`parseOpenClawOutput`/`parseOpenCodeOutput`/`parseDirectOutput`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/process-runner.ts — `SpawnCommandRunner` (spawn con `process_group`, allowlist de envs no-secretas, redacción de secretos en stderr, kill grace) — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/secure-files.ts — `readOwnerOnlyFile` (sin `O_NOFOLLOW`, valida 0o600) y `readBearerTokenFile` — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/types.ts — `AdapterCapabilities`, `HarnessId`, `CommandRunner`, `CommandRunResult`, `Delivery`, `DeliveryEvent`, `StructuredOutput`, `OutputArtifact`, etc. — Codex (adapter-sdk)
- packages/adapter-sdk/src/sdk/websocket-transport.ts — `WebSocketConsumerConnector` (conexión WS/WSS con mTLS opcional, parsea y valida cada frame entrante contra `WsInboundSchema`, backoff de reconexión) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/config.ts — `loadSharedSessionConfig` desde `CAUCE_SHARED_SESSION`/`CAUCE_SHARED_SESSION_WORKSPACE`, deriva HOME/config del arnés — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/degradation-log.ts — `recordDegradation`/`readDegradations` (append-only log de eventos de degradación de la sesión compartida; nunca propaga fallos de escritura) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/envelope.ts — `correlateEnvelopePrompt` (inyecta el bloque obligatorio de correlación al prompt) y `envelopeHasCorrelation` (valida sobres extraídos del transcript) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/index.ts — barrel del módulo `shared-session` — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/notice.ts — marcas literales (`DEGRADED_MARK`, `RESET_MARK`, `CONTEXT_MARK`, `MERGED_MARK`) y razón→texto por `DegradationReason` — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/pane.ts — `inputBoxState` (detecta caja libre/ocupada/modal en panes tmux de TUI) y `turnInFlight` — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/paste-runner.ts — barrel del runner (`PasteSessionRunner`, `fileQuarantinePersistence`, `turnBudgetMs`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/paste-runner/base.ts — `PasteSessionRunnerBase` (lógica común: garantizar sesión, decidir turno, inyectar prompt, modo fallback) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/paste-runner/contracts.ts — `PasteSessionOptions`, `FileQuarantineState`, `QuarantinePersistence`, `PendingQuarantine` — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/paste-runner/harvest.ts — `PasteSessionHarvestRunner` (cosecha sobres estructurados del transcript, gestiona el correlation id) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/paste-runner/persistence.ts — `fileQuarantinePersistence` (escritura atómica con `.tmp`/`.pending` y marcador de generación) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/paste-runner/runner.ts — `PasteSessionRunner` (orquesta el pegado del prompt en la TUI con fence por pane, reintento por cancelación) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/paste-runner/runtime.ts — constantes de timeout (`DEFAULT_ACQUIRE_TIMEOUT_MS`, `DEFAULT_CANCEL_DRAIN_TIMEOUT_MS`, `turnBudgetMs`), helpers `beforeAbort`/`beforeDeadline` — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/resume.ts — `sharedSessionResume` (devuelve `ResumeSpec` con args `--resume`/`--continue` y `hasPreviousConversation` para claude y codex) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/rollout.ts — parser de rollouts JSONL de Codex (`rolloutDirectory`, `rolloutSessionId`, identificación de compactaciones) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/session.ts — `ensureSharedSession`/`sharedSessionStatus` (crea/inspecciona la sesión tmux compartida de un alias+harness con nonce y verificación de pane) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/tmux.ts — barrel del submódulo tmux (`CliTmux`, `paneIdentity`, operaciones de cuarentena, barreras de entrada) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/tmux/identity.ts — interfaz `TmuxController`, tipos `PaneIdentity`/`PaneHarnessIdentity`/`CreatedSessionOwnership`, `CliTmux` (cliente tmux de respaldo) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/tmux/mutation.ts — `atomicCas`/`mutateExactPane`/`mutateUnderInputBarrier` (mutación CAS contra la generación del pane usando `if-shell -F`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/tmux/operations.ts — `pastePrompt`/`sendEnter`/`acquirePaneInputBarrier`/`releasePaneInputBarrier`, marcas `QUARANTINED_PANE_OPTION` — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/transcript.ts — parser de transcripts JSONL de Claude (`TranscriptEntry`, resolución de cadena de padres con compactaciones, `findEnvelope`) — Codex (adapter-sdk)
- packages/adapter-sdk/src/shared-session/types.ts — `SharedSessionHarness` (claude|codex), `DegradationReason` (session_absent, tui_absent, modal_blocking...), `TranscriptReader`, `ResumeSpec`, constantes — Codex (adapter-sdk)


## B. services/ (gateway, dispatcher, terminal-relay, telegram-bridge)

### services/dispatcher/src/ (6)
- services/dispatcher/src/config.ts — carga y valida variables de entorno del dispatcher (poll, ACK, lease, retention, chain-sweep) con invariantes entre ventanas — Codex (gateway)
- services/dispatcher/src/handlers.ts — registro cerrado de handlers de job (sólo `system.database.probe` y `qa.fairness` en test) con validación tipada del payload — Codex (gateway)
- services/dispatcher/src/index.ts — bucle principal del dispatcher: retry de deliveries vencidas, expiración de jobs, sweep de cadenas mudas, claim con fair-share, poda de observabilidad y ACK durable — Codex (gateway)
- services/dispatcher/src/main.ts — entry-point HTTP del dispatcher: `/health/live`, `/health/ready`, `/metrics` y validación de TLS al postgres — Codex (gateway)
- services/dispatcher/src/metrics.ts — contadores y gauges Prometheus del dispatcher (ticks, jobs por lane/outcome, colas Postgres, outbox de wakes, leases) — Codex (gateway)
- services/dispatcher/src/scheduler.ts — **RETIRO (2026-08-27 ronda 4):** la alternancia interactive/batch vive ahora en `packages/store/src/repository/jobs.ts` (`job_lane_fairness`); este fichero ya no existe en `git ls-files`.

### services/gateway/src/ (36)
- services/gateway/src/agent-directive-degrada.test.ts — tests de la respuesta degradada `/directive` cuando no hay hechos medidos del contenedor (medido=false, files=null, motivo explicativo) — Codex (gateway)
- services/gateway/src/app.ts — entry-point Fastify del gateway: registra WebSocket, AuthProviders, ConsoleSecurityHook, phases de console routes y runtime routes — Codex (gateway)
- services/gateway/src/auth.ts — AuthProvider, Principal, AuthError, JwksJwtVerifier (JWKS+RS256/PS256/ES256), `DevOnlyAuthProvider`, `MtlsAuthProvider`, `HashedTokenFileAuthProvider`, `HashedMtlsIdentityFileProvider` — Codex (gateway)
- services/gateway/src/config.test.ts — tests de `configuredAckDeadlineMs` y `configuredDeliveryAdmission` con invariantes de admisibilidad (cupo no ambos cero) — Codex (gateway)
- services/gateway/src/config.ts — validación de plazos ACK/deadline, lease cap, delivery admission (`maxInflightDeliveries`, `humanReservedDeliveries`) — Codex (gateway)
- services/gateway/src/console-audit.test.ts — tests de `/v3/console/audit` con paginación y allowlist de campos seguros (sin summary metadata) — Codex (gateway)
- services/gateway/src/console-dlq.test.ts — tests de `/v3/console/dlq` y `resolve-without-replay` con CSRF/origen y filtrado de campos sensibles — Codex (gateway)
- services/gateway/src/console-message-body.test.ts — tests de `GET /v3/console/messages/:messageId` con cuerpo completo, visibilidad cruzada por destinatario y filtrado de fan-out — Codex (gateway)
- services/gateway/src/console-publish-intent.test.ts — tests del flujo console publish-intent: prepare, confirm, scope del operador, priorización humana — Codex (gateway)
- services/gateway/src/console-publish-telemetry.test.ts — tests del contador Prometheus identity-free de console publish (operación/resultado, sin labels) — Codex (gateway)
- services/gateway/src/console-publish-telemetry.ts — `ConsolePublishTelemetry`: contadores sin labels y `consolePublishTelemetryVocabulary` cerrado (operación×resultado) — Codex (gateway)
- services/gateway/src/console-security.ts — `createConsoleSecurityHook`: hook `onRequest` que allowlista Origin exacto, manda `Vary: Origin` y cierra el socket ante `sec-fetch-site: cross-site` o mutación sin Origin — Codex (gateway)
- services/gateway/src/console-user-cli.ts — CLI para alta/cambio/baja de usuarios de consola en `console_users` (lee contraseña sin eco, valida política, hash scrypt) — Codex (gateway)
- services/gateway/src/console-users.ts — `ConsoleUserStore` (Postgres + memoria): `findByEmail`, `findById`, `recordLogin` y normalización de email — Codex (gateway)
- services/gateway/src/facades.dlq.test.ts — tests de las facadas `safeAuditPage`, `safeDlqPage`, `safeReplayReceipt`, `safeCancelReceipt` con segunda allowlist de seguridad — Codex (gateway)
- services/gateway/src/facades.ts — proyecciones browser-seguras (`safeAuditPage`, `safeDlqPage`, `safeDlqResolution`, `safeReplayReceipt`, `safeCancelReceipt`) que duplican la allowlist — Codex (gateway)
- services/gateway/src/health-progress.test.ts — tests de los `probe*Path` con catálogos exactos, índices y triggers (015/031-037) — Codex (gateway)
- services/gateway/src/health-schema037.pg.test.ts — test focal schema-037 contra PostgreSQL real con grants/revocations — Codex (gateway)
- services/gateway/src/health.ts — `buildLoopbackHealthProbe`, `renderWakePumpMetrics`, `renderConsolePublishMetrics`, `probeAckPath`, `registerHealthRoutes` — Codex (gateway)
- services/gateway/src/index.ts — barrel de exports públicos del paquete gateway — Codex (gateway)
- services/gateway/src/main.ts — entry-point del gateway: carga auth (OIDC/password/mTLS/token-file), instancia Fastify, init de plugins y shutdown ordenado — Codex (gateway)
- services/gateway/src/mtls-health.test.ts — test de aislamiento del health server mTLS vs data plane (puerto distinto, sin datos en health) — Codex (gateway)
- services/gateway/src/oidc-bff.test.ts — tests del OIDC BFF con JWKS firmados en memoria: PKCE, refresh rotation, CSRF, mitigación de fixation — Codex (gateway)
- services/gateway/src/oidc-bff.ts — `OidcBffAuthProvider` + `PostgresOidcSessionStore`: login con cookies HttpOnly+Secure+SameSite=Strict, rotación, encrypted at rest — Codex (gateway)
- services/gateway/src/password-auth.test.ts — tests de `PasswordAuthProvider`: login, throttle, CSRF, gate de console surface vs bus — Codex (gateway)
- services/gateway/src/password-auth.ts — `PasswordAuthProvider`: bcrypt-scrypt+HS256 JWT, throttle por correo normalizado, gate por canal — Codex (gateway)
- services/gateway/src/password.test.ts — tests de `hashPassword`/`verifyPassword`: salts únicos, política ≥12 chars, hash inválido devuelve false — Codex (gateway)
- services/gateway/src/password.ts — derivación de contraseña scrypt (PHC format) con sales aleatorios y verificación constant-time — Codex (gateway)
- services/gateway/src/publish-priority-policy.test.ts — tests de `publishPriorityDecision`: human band vs agent ceiling vs unchanged — Codex (gateway)
- services/gateway/src/publish-priority-policy.ts — `publishPriorityDecision`: aplica el techo de agente y eleva a HUMAN_CHAT_PRIORITY sólo con `operator_id` autenticado en compose interactivo — Codex (gateway)
- services/gateway/src/publish-priority.test.ts — tests E2E del clamp de prioridad en `/v3/messages` y `/v3/console/messages` con `DevOnlyAuthProvider`, agent ceiling, human band y log de clamp — Codex (gateway)
- services/gateway/src/terminal.authority.test.ts — tests de `GrantStore`, `routingAuthority`, `cohortRoutingAuthority` y `resolveOperator` con fingerprint set — Codex (gateway)
- services/gateway/src/terminal.plugin.test.ts — tests E2E del PTY control plane sobre Fastify in-memory con database double completa — Codex (gateway)
- services/gateway/src/terminal.relay-identity.test.ts — test de identidad derivada del cert TLS leaf (SHA-256) con fencing de body claims — Codex (gateway)
- services/gateway/src/terminal.tickets.test.ts — golden vectors del ticket PTY: HKDF, HMAC-SHA256, payload canónico byte-by-byte — Codex (gateway)
- services/gateway/src/wake-pump-telemetry.ts — `WakePumpTelemetry`: contadores sin labels, estado del pump, snapshot identity-free para Prometheus — Codex (gateway)

### services/gateway/src/console/ (16)
- services/gateway/src/console/agent-directive.routes.test.ts — tests de `GET /v3/console/agents/:tenant/:alias/directive` con Codex override precedence, Hermes y OpenCl truncado, timeout global — Codex (gateway)
- services/gateway/src/console/agent-directive.routes.ts — ruta `GET /v3/console/agents/:tenant/:alias/directive` con presupuesto global 5s, discriminante `medido` y lectura paralela gobernada — Codex (gateway)
- services/gateway/src/console/agent-documents.read.test.ts — tests de `verifyReadablePath` y `TerminalRelayFactsProbe.readGovernanceDocument` con allowlist cerrada y rechazo de symlinks — Codex (gateway)
- services/gateway/src/console/agent-documents.routes.test.ts — tests de tenant-qualified mapa/contenido/escritura con doble allowlist y preflight fresco — Codex (gateway)
- services/gateway/src/console/agent-documents.routes.ts — rutas tenant-qualified mapa+contenido+escritura con doble allowlist (`verifyReadableDocument`, `verifyWritablePath`) y ACK de escritura del pty-agent — Codex (gateway)
- services/gateway/src/console/agent-documents.test.ts — tests de `resolveAgentDocuments`, `effectiveManualPaths` y `verifyWritablePath` con harness desconocido y rutas sensibles — Codex (gateway)
- services/gateway/src/console/agent-documents.ts — `RuntimeFacts`, `resolveAgentDocuments`, `verifyReadablePath`, `verifyWritablePath`, `TerminalRelayFactsProbe` y `TerminalRelayFactsProbe.presence()` — Codex (gateway)
- services/gateway/src/console/agent-profile-runtime.test.ts — tests de `prepareAgentProfileRuntime` con preflight, batch OpenClaw 7 docs y revalidación de identidad — Codex (gateway)
- services/gateway/src/console/agent-profile-runtime.ts — `prepareAgentProfileRuntime`: lee cada documento gobernado, compone lote, verifica precondiciones y revalida identidad al cerrar — Codex (gateway)
- services/gateway/src/console/agent-profile.routes.test.ts — tests de `GET/PUT /v3/console/.../perfil` con desired durable, ACK runtime, retracted y orden de revalidación — Codex (gateway)
- services/gateway/src/console/agent-profile.routes.ts — rutas `GET/PUT` del perfil autorado: lectura de contexto, reemplazo CAS, runtime verification, applied durable — Codex (gateway)
- services/gateway/src/console/relay-governance-client.test.ts — tests del `HttpGovernanceRelayClient` sobre HTTPS con TLS recíproco y validación de respuestas — Codex (gateway)
- services/gateway/src/console/relay-governance-client.ts — `HttpGovernanceRelayClient`: cliente HTTPS mTLS al terminal-relay para read/list/write/write-batch con parsing estricto — Codex (gateway)
- services/gateway/src/console/sonda-compartida.test.ts — tests del `SondaCompartida` + `sondaDiferida`: degradada contesta "unavailable", resolución en cada llamada — Codex (gateway)
- services/gateway/src/console/sonda-compartida.ts — `SondaCompartida` + `sondaDiferida`: hueco mutable donde el plano de terminal inyecta el probe real después del arranque — Codex (gateway)
- services/gateway/src/console/types-agent-directive.ts — tipos espejo del frontend para `AgentDirective`, `AgentDirectiveFile`, `AgentMemoryIndex` (available/unavailable) — Codex (gateway)

### services/gateway/src/health/ (4)
- services/gateway/src/health/schema-console-publish-intent.ts — `probeConsolePublishIntentPath`: valida indices de migración 037 contra PostgreSQL con `pg_get_indexdef` — Codex (gateway)
- services/gateway/src/health/schema-delivery.ts — `probeDeliveryAdmissionPath` (015) y `probeWakePath` (031) read-only con `pg_catalog` — Codex (gateway)
- services/gateway/src/health/schema-profile-runtime.ts — `probeProfileRuntimePath` (035): columnas exactas, constraints, funciones, triggers y permisos — Codex (gateway)
- services/gateway/src/health/schema-terminal.ts — `probeTerminalClaimPath`/`probeTerminalBrowserOwnerPath`/`probeTerminalRelayInstancePath` (032/033/034) — Codex (gateway)

### services/gateway/src/routes/ (6)
- services/gateway/src/routes/console.ts — `createConsoleRoutes` + cuatro phases (access/topology, messages, profiles+documents+agents+chains+dlq, config+terminal capability) — Codex (gateway)
- services/gateway/src/routes/core.ts — `createCoreRoutePhases`: publish routes, WebSocket `/v3/ws` con sesión mutable, drainer por sesión, outbox pump, ACK de wakes — Codex (gateway)
- services/gateway/src/routes/health.ts — `registerGatewayHealthRoutes`: `/v3/status` autenticado + opcional `/health/*` cuando NO es mTLS — Codex (gateway)
- services/gateway/src/routes/legado-candidato.test.ts — **RETIRO (2026-08-27 ronda 4):** renombrado a `chain-gates-legado.test.ts`. Ver entrada nueva abajo.
- services/gateway/src/routes/legado-candidato.ts — **RETIRO (2026-08-27 ronda 4):** renombrado a `chain-gates-legado.ts` (97 líneas, registra `registerLegacyCandidateChainGateRoutes` gated por `enableLegacyCandidateRoutes`).
- services/gateway/src/routes/chain-gates-legado.ts (NUEVO 2026-08-27) — antes `legado-candidato.ts`: rutas legacy candidatas `/v3/console/publish-intents`, `/confirm`, `/chain-gates` (list/answer/cancel) gated por `enableLegacyCandidateRoutes` — Codex (gateway)
- services/gateway/src/routes/chain-gates-legado.test.ts (NUEVO 2026-08-27) — antes `legado-candidato.test.ts`: tests del flag `enableLegacyCandidateRoutes` — Codex (gateway)
- services/gateway/src/routes/shared.ts — utilidades compartidas: `principal`, `routedPriority` (human band vs agent ceiling), `validatedPublishReceipt` (igualdad exacta de hash causal), `principal`, `replyError` — Codex (gateway)

### services/gateway/src/terminal/ (12)
- services/gateway/src/terminal/audit.ts — `recordTerminalAudit` no transaccional + `terminalAuditMetadata` con campos comunes (operator_id, attributed, cohort, mode) — Codex (gateway)
- services/gateway/src/terminal/authority.ts — `GrantStore` (file-backed 1s cache), `routingAuthority`, `cohortRoutingAuthority`, `containerCohort`, `attributionAllows`, `resolveOperator` — Codex (gateway)
- services/gateway/src/terminal/config.ts — `loadTerminalConfig`: carga de env condicional (sólo con `CAUCE_TERMINAL_ENABLED=1`) con TTL/lease/grants/operadores — Codex (gateway)
- services/gateway/src/terminal/governance-probes.ts — `createGovernanceProbes`: monta `TerminalRelayFactsProbe` con cliente HTTP mTLS y la inyecta en `sondaDeDocumentos` — Codex (gateway)
- services/gateway/src/terminal/hechos-del-registro.test.ts — tests de `hechosDelRegistro` mapeando presencia del agente a `RuntimeFacts` con hechos parciales rechazados — Codex (gateway)
- services/gateway/src/terminal/hechos-del-registro.ts — `hechosDelRegistro`: deriva `RuntimeFacts` medidos de la presencia del pty-agent con validación canónica de rutas — Codex (gateway)
- services/gateway/src/terminal/plugin.ts — `registerTerminalControlPlane`: plugin del PTY control plane con Fase1/2/3/4 de console + relay proxy + directiva — Codex (gateway)
- services/gateway/src/terminal/registry.ts — `AgentRegistry` + `parseAgentPresence`: snapshot por relay-certificado con fencing de boot conflict — Codex (gateway)
- services/gateway/src/terminal/relay-proxy.ts — `registerTerminalRelayProxy`: rutas `/v3/terminal/relay/{agents,consume,resume,authz,close}` con mTLS — Codex (gateway)
- services/gateway/src/terminal/session-control.ts — `registerTerminalSessionControl`: issuance, owner rotation, revocation con auditoría transaccional y fence de claim — Codex (gateway)
- services/gateway/src/terminal/tickets.ts — ticket PTY v1 frozen: HKDF por alias, HMAC-SHA256, payload canónico, resume token con dominio separado — Codex (gateway)
- services/gateway/src/terminal/types.ts — tipos compartidos del PTY plane: `FleetPlacement`, `AgentPresence`, `TerminalSessionRow` (claim_epoch como string) — Codex (gateway)

### services/telegram-bridge/src/ (20)
- services/telegram-bridge/src/activity.ts — `TelegramActivityIndicator`: typing + reacciones 👀/🤔/👍/👎 por mensaje con tombstone terminal — Gemini (canales)
- services/telegram-bridge/src/addressing.ts — `resolveAddressing` con tabla de precedencia P0-P10 (mention, command, reply, ambient) y flota participante — Gemini (canales)
- services/telegram-bridge/src/artifacts.ts — `planArtifacts`: data: URIs, enlaces y rutas del agente con sniff JPEG/PNG/WEBP, SHA-256 y header — Gemini (canales)
- services/telegram-bridge/src/attachments.ts — `prepareTelegramAttachments` (mime+ext+magic allowlist) y `prepareTelegramVoice` (transcripción por magic bytes) — Gemini (canales)
- services/telegram-bridge/src/config.ts — parseo/validación del JSON de `telegram_bridge.json`: alias, chats, threads, fleet directory, ambient-host — Gemini (canales)
- services/telegram-bridge/src/egress.ts — `TelegramEgressWorker`: claim→prepare→begin→send→complete→ack con ACK exacto y degradation a texto plano — Gemini (canales)
- services/telegram-bridge/src/health.ts — `TelegramBridgeMetrics` (Prometheus sin labels) y servidor HTTP interno `/health/{live,ready,metrics}` — Gemini (canales)
- services/telegram-bridge/src/index.ts — barrel de exports del paquete telegram-bridge — Gemini (canales)
- services/telegram-bridge/src/ingress-body.ts — `normalizedBody`: redacta secretos, prepara adjuntos+voz, prompt UNTRUSTED con detección de impersonación — Gemini (canales)
- services/telegram-bridge/src/ingress.ts — `StoreTelegramIngress`: publica a Cauce con prioridad humana sólo si la fuente es una persona real — Gemini (canales)
- services/telegram-bridge/src/main.ts — entry-point del puente: crea poller por alias, migra DB, installa health server y maneja SIGINT/SIGTERM — Gemini (canales)
- services/telegram-bridge/src/markdown.ts — `markdownToTelegramHtml`: conversión Markdown→HTML (bloques de código, tablas, enlaces, citas) con degradación a texto plano — Gemini (canales)
- services/telegram-bridge/src/poller.ts — `TelegramPoller`: lease, cursor destructivo, accepted→addressing→publish con `processWithLeaseHeartbeat` — Gemini (canales)
- services/telegram-bridge/src/progress.ts — `TelegramBridgeProgress`: snapshots sin labels de pollers/egress con bounded stale windows — Gemini (canales)
- services/telegram-bridge/src/redaction.ts — `redactSecrets`/`redactSecretsDeep`: redacta PEM, JWT, telegram bot tokens, bearer tokens, URIs con credenciales — Gemini (canales)
- services/telegram-bridge/src/repository.ts — `PostgresTelegramBridgeRepository`: cursor, lease, claim/renew/ack de origin_relay y ACK exacto de telegram_egress_effects — Gemini (canales)
- services/telegram-bridge/src/telegram.ts — `TelegramHttpClient`: getUpdates/getFile/downloadFile/sendText/sendPhoto/sendDocument/setMessageReaction — Gemini (canales)
- services/telegram-bridge/src/transcription.ts — `transcribeAudio`: POST multipart a API OpenAI-compatible con timeout y saneo de controles/invisibles — Gemini (canales)
- services/telegram-bridge/src/types.ts — tipos compartidos (TelegramMessage, TelegramChatPolicy, Effect/Outcome, BridgeMetric) — Gemini (canales)
- services/telegram-bridge/src/untrusted.ts — saneo de nombres (control/invisible/whitespace) + `confusableSkeleton` para detección de suplantación — Gemini (canales)

### services/terminal-relay/src/ (33)
- services/terminal-relay/src/agent-connection.ts — `AgentConnection`: socket mTLS multiplexado con cola bounded, ping/pong, dispatch de READ/WRITE/OPEN — Gemini (canales)
- services/terminal-relay/src/agent-hello.ts — parseo+validación del HELLO (runtime_facts_observed, codex_home, claude_config_dir, openclaw_workspace) y features — Gemini (canales)
- services/terminal-relay/src/agent-leg.ts — `AgentLeg`: listener mTLS con verificación de cert contra `pty_agent_identities.json` y dual-socket fenced — Gemini (canales)
- services/terminal-relay/src/agent-leg.test.ts — tests del agent leg con certs de test contra AgentRegistry y lifecycle — Gemini (canales)
- services/terminal-relay/src/browser-leg.ts — `BrowserLeg`: upgrade WebSocket mTLS con Origin check, claim broker y rate-limit de attach — Gemini (canales)
- services/terminal-relay/src/config.ts — `loadRelayConfig` desde env con validación cruzada de puertos y lease vs authz+grace — Gemini (canales)
- services/terminal-relay/src/framing.ts — wire contract `[tag:1][len:4BE][payload]`: encoders/decoders JSON y DATA con prefijo sessionId (36 bytes) — Gemini (canales)
- services/terminal-relay/src/framing.test.ts — tests del wire contract: encoders producen bytes canónicos, decoder valida tags/longitudes — Gemini (canales)
- services/terminal-relay/src/gateway-client.ts — `HttpsTerminalGatewayClient`: consumeTicket/resumeSession/authorizeSession/reportClose/publishPresence mTLS — Gemini (canales)
- services/terminal-relay/src/governance-read.ts — `requestFileRead`/`requestDirectoryRead` con bounded memoria, validate alias/ruta y errores normalizados — Gemini (canales)
- services/terminal-relay/src/governance-relay.ts — `setupGovernanceRelay`: engancha `/v3/terminal/relay/{read,list,write,write-batch}` al HTTPS del browser leg — Gemini (canales)
- services/terminal-relay/src/governance-relay.test.ts — tests del HTTP read/list/write/write-batch con mTLS y token compartido — Gemini (canales)
- services/terminal-relay/src/governance-relay-mutations.test.ts — tests del gobierno de escritura por lote con perfil OpenClaw y preflight — Gemini (canales)
- services/terminal-relay/src/governance-write.ts — `requestFileWrite`/`requestFileWriteBatch` CAS extremo-a-extremo con verificación de path/SHA/bytes — Gemini (canales)
- services/terminal-relay/src/health.ts — `RelayHealthState`: ready sólo si listeners arriba + presence publicada dentro de stale window — Gemini (canales)
- services/terminal-relay/src/health.test.ts — tests del relay health: ready/not_ready según listeners+presence+stale — Gemini (canales)
- services/terminal-relay/src/log.ts — `logEvent`/`shortFingerprint`/`errorLabel`: structured logging con fingerprint truncado a 16 hex — Gemini (canales)
- services/terminal-relay/src/main.ts — entry-point del terminal-relay: agent+browser HTTPS, SessionManager, presence publish debounced y SIGTERM orderly — Gemini (canales)
- services/terminal-relay/src/read-governance.test.ts — tests de la ruta read con mTLS recíproco y validación de ruta contra allowlist — Gemini (canales)
- services/terminal-relay/src/read-governance-directory.test.ts — test del índice de directorio con allowlist cerrada (símbolos y sensibles) — Gemini (canales)
- services/terminal-relay/src/relay-circuit.test.ts — test del flujo completo attach/expire/reauthorize con doble socket — Gemini (canales)
- services/terminal-relay/src/relay-identity.ts — `relayInstanceIdFromCertificate` (SHA-256 del DER leaf) + `relayProcessIdentity` con boot UUID — Gemini (canales)
- services/terminal-relay/src/relay-test-fixtures.ts — fixtures para tests del relay — Gemini (canales)
- services/terminal-relay/src/relay.test.ts — tests end-to-end del relay con mTLS contra Fastify in-memory — Gemini (canales)
- services/terminal-relay/src/session-instance.ts — `TerminalSession`: ciclo OPEN/PTY/READ/STDOUT/CLOSE con claim lease, retry authz y graceful shutdown — Gemini (canales)
- services/terminal-relay/src/session-limits.ts — constantes del protocolo (CLOSE_CODES, MAX_COLS/ROWS, FLOOD windows, claim lease TTL bounds) — Gemini (canales)
- services/terminal-relay/src/session-spool.ts — `loadCloseSpool`/`persistCloseSpool` v2 con fsync atómico y verificación 0600 — Gemini (canales)
- services/terminal-relay/src/session-spool.test.ts — tests del spool atómico de close reports (fsync, rename, modo 0600) — Gemini (canales)
- services/terminal-relay/src/sessions.ts — `SessionManager`: gestiona open/reattach/closeAll/scrollback/spool retry-forever de close reports — Gemini (canales)
- services/terminal-relay/src/sessions.test.ts — tests de la `SessionManager`: open/reattach/release con índices por container — Gemini (canales)
- services/terminal-relay/src/sessions-recovery.test.ts — tests de la saga de recovery post-restart con fence de identidad de relay — Gemini (canales)
- services/terminal-relay/src/write-governance.test.ts — tests del reemplazo atómico con ACK path/op/sha/bytes exactos — Gemini (canales)
- services/terminal-relay/src/write-governance-batch.test.ts — tests del batch de escritura con rollback y SHA-256 correlacionado por entrada — Gemini (canales)


## C. console/ + scripts/ + vitest.config.ts

### console/src/ (279x)
- console/src/App.invariantes.test.tsx — invariantes estructurales de la tabla de rutas: ids duplicados, componentes sin definir, alias sin destino real — Gemini (consola)
- console/src/App.test.tsx — pruebas de integración del router: reescritura de alias, fallback 404, deep-link a /fleet/:tenant/:alias — Gemini (consola)
- console/src/App.tsx — router principal con reescritura de alias (licenses→accounts, activity→live, etc.) — Gemini (consola)
- console/src/main.tsx — bootstrap ReactDOM + arranque condicional de MSW según VITE_USE_MOCKS — Gemini (consola)
- console/src/api/audit-client.test.ts — pruebas de `listAudit()` contra el handler mock — Gemini (consola)
- console/src/api/client.test.ts — pruebas de fetch con CSRF, cookie credentials y borrado de campos hostiles — Gemini (consola)
- console/src/api/client.timeout.test.ts — suite de timeouts con fetch que nunca responde — Gemini (consola)
- console/src/api/client.ts — clase `CauceApi` que envuelve fetch con timeout 30s, headers `X-Cauce-Console` y propagación de CSRF — Gemini (consola)
- console/src/api/client/agent-client.ts — métodos agent-* (perfil, directiva, documentos) sobre `CauceApi` — Gemini (consola)
- console/src/api/client/core.ts — núcleo HTTP: timeout AbortController, errores tipados `PublishIntentReconciliation/Expired/RateLimited` — Gemini (consola)
- console/src/api/client/messaging-client.ts — publishMessage, preparePublishIntent, confirmPublishIntent con tipos exactos — Gemini (consola)
- console/src/api/client/system-client.ts — auth/session, access, topology, config, observability, audit — Gemini (consola)
- console/src/api/context.tsx — provider `ApiProvider` y hook `useApi()` — Gemini (consola)
- console/src/api/types.ts — re-exports de los schemas por dominio — Gemini (consola)
- console/src/api/types/activity.ts — FleetActivitySnapshot, FleetActivityAgent, FleetActivityItem, FleetDelegationEdge — Gemini (consola)
- console/src/api/types/agent-directives.ts — tipos para perfil, directiva (capas 1-3), historial de rol y documentos — Gemini (consola)
- console/src/api/types/auth.ts — ConsolePermission, LoginMode, ConsoleAuthState, ConsoleAccess — Gemini (consola)
- console/src/api/types/chains.ts — AgentChainEdge, AgentChainNode, AgentChainSnapshot, AgentChainCounters — Gemini (consola)
- console/src/api/types/config.ts — ConfigResource, RegistryConfigResource, ConfigAction, ConfigMutation — Gemini (consola)
- console/src/api/types/deliveries.ts — DeliveryState, JobLane, TimelineEvent, DeliveryView, MessageView, MessagePage — Gemini (consola)
- console/src/api/types/dlq.ts — DlqTarget, DlqDisposition, DlqItem, DlqPage, ResolveDlqWithoutReplayResult — Gemini (consola)
- console/src/api/types/quotas.ts — QuotaSeverity, QuotaWindow, QuotaGroup, QuotaProviderReport, QuotaCollector, QuotaUnboundGroup, QuotaPausedAccount, QuotaThresholds, QuotaSnapshot — Gemini (consola)
- console/src/api/types/system.ts — CapabilityState, PresenceLease, SystemStatus, TerminalCapability, ObservabilitySnapshot — Gemini (consola)
- console/src/api/types/topology.ts — MemberOffReason, RoomMember, TenantNode, AclEdge, TopologySnapshot — Gemini (consola)
- console/src/api/use-resource.fallo-visible.test.tsx — pruebas de fallo de red: timeout, 5xx, mensaje legible — Gemini (consola)
- console/src/api/use-resource.test.tsx — smoke del hook `useResource` con polling manual — Gemini (consola)
- console/src/api/use-resource.ts — hook genérico de lectura de recursos con `key` por scope y manejo de cache — Gemini (consola)
- console/src/components/Tooltip.test.tsx — accesibilidad y disparo del globo en hover/focus/Esc — Gemini (consola)
- console/src/components/Tooltip.tsx — ⚠ el nombre miente: es la primitiva `Tooltip`/`FloatingTooltip` con `createPortal` y `aria-describedby` — Gemini (consola)
- console/src/components/ui.tsx — primitivas reusables: `Badge`, `Panel`, `PageHeader`, `Metric`, `LoadingState`, `ErrorState`, `ViewTabs`, `Unknown` — Gemini (consola)
- console/src/components/view-tabs-legibilidad.test.ts — `ViewTabs` legible en tema claro (contraste ≥4.5:1) — Gemini (consola)
- console/src/contraste-cascada.test.ts — pruebas unitarias de contraste heredado en hojas globales — Gemini (consola)
- console/src/features/accounts/AccountRoutingDetail.tsx — ficha desplegable con plan, pagador, agentes asignados, techo de ruteo — Gemini (consola)
- console/src/features/accounts/AccountsInventory.tsx — tabla maestra con inventario/edición/altabaja de cuentas de IA y barra de pool — Gemini (consola)
- console/src/features/accounts/AccountsPage.test.tsx — render con fixtures: 38 filas, edición inline, validaciones de IDs — Gemini (consola)
- console/src/features/accounts/AccountsPage.tsx — orquesta AccountsInventory + ConsumptionSection + AssignmentMatrix — Gemini (consola)
- console/src/features/accounts/AssignmentMatrix.test.tsx — render de la matriz agente×cuenta — Gemini (consola)
- console/src/features/accounts/AssignmentMatrix.tsx — matriz interactiva de asignación cuenta×agente — Gemini (consola)
- console/src/features/accounts/ConsumptionSection.test.tsx — render del panel de consumo — Gemini (consola)
- console/src/features/accounts/ConsumptionSection.tsx — panel de consumo por cuenta y ventana de cuota — Gemini (consola)
- console/src/features/accounts/MutationBar.tsx — barra inferior con previsualizar/aplicar y mensaje de error — Gemini (consola)
- console/src/features/accounts/Sparkline.tsx — sparkline SVG minimalista con datos submuestreados — Gemini (consola)
- console/src/features/accounts/licenses-calculation.test.ts — cálculo de licencias disponibles/expiradas — Gemini (consola)
- console/src/features/accounts/licenses.test.ts — pruebas del módulo de licencias — Gemini (consola)
- console/src/features/accounts/licenses.ts — cálculo de licencias: vigentes/expiradas/pool — Gemini (consola)
- console/src/features/accounts/quotas.test.ts — agregación de grupos por familia y peor ventana — Gemini (consola)
- console/src/features/accounts/quotas.ts — agregación de cuotas por familia (antigravity) y selección de peor ventana — Gemini (consola)
- console/src/features/accounts/registry.test.ts — lectura y validación de la lista de agentes del registro — Gemini (consola)
- console/src/features/accounts/registry.ts — lectura normalizada del registro de agentes (membership/flag/pool) — Gemini (consola)
- console/src/features/accounts/use-registry-mutation.ts — hook que aplica cambios sobre el registro de agentes vía config — Gemini (consola)
- console/src/features/audit/AuditPanel.test.tsx — paginación keyset con filtros y traducciones JSON — Gemini (consola)
- console/src/features/audit/AuditPanel.tsx — paginador keyset del audit log con buscador — Gemini (consola)
- console/src/features/audit/audit-summary.test.ts — traduce JSON allowlist del audit a frases humanas — Gemini (consola)
- console/src/features/audit/audit-summary.ts — formateador de resúmenes estructurados del audit log — Gemini (consola)
- console/src/features/auth/AuthGate.test.tsx — pruebas de la puerta de sesión (loading/sin sesión/sesión/permiso) — Gemini (consola)
- console/src/features/auth/AuthGate.tsx — puerta de sesión con login por contraseña o redirect OIDC y badge en la topbar — Gemini (consola)
- console/src/features/auth/auth-session.ts — hook `useAuthGate` que consulta `/v3/auth/session` y revalida cada 60s — Gemini (consola)
- console/src/features/config/AltaDeEspacios.tsx — exporta el alta de espacios (AltaRapida | SpaceWizard) — Gemini (consola)
- console/src/features/config/AltaRapida.tsx — formulario de alta de un solo recurso (membership/acl_edge/room/agent) — Gemini (consola)
- console/src/features/config/ArnesesPanel.tsx — panel «qué lee cada arnés» con 4 arneses (claude/codex/openclaw/hermes) — Gemini (consola)
- console/src/features/config/CollectionTable.tsx — tabla interactiva con interruptores para colecciones de configuración — Gemini (consola)
- console/src/features/config/ConfigPage.actions.test.tsx — pruebas de las acciones de tabla (toggles, cambios de rol, confirm) — Gemini (consola)
- console/src/features/config/ConfigPage.inertes.test.tsx — pruebas de la pestaña «Agentes y cuentas» con arneses inertes — Gemini (consola)
- console/src/features/config/ConfigPage.tables.test.tsx — render de tablas con/sin campos inertes — Gemini (consola)
- console/src/features/config/ConfigPage.test.tsx — tests integración de ConfigPage (permisos, fallback 403) — Gemini (consola)
- console/src/features/config/ConfigPage.tsx — página «Ajustes y altas» con 7 pestañas (config, espacios, permisos, arneses, roles, etc.) — Gemini (consola)
- console/src/features/config/Interruptor.tsx — switch accesible con tooltip/cabecera/diálogo de confirmación — Gemini (consola)
- console/src/features/config/RolesPanel.tsx — panel de políticas de rol (route/read/control/notify) — Gemini (consola)
- console/src/features/config/SpaceWizard.test.tsx — pruebas del wizard de espacios — Gemini (consola)
- console/src/features/config/SpaceWizard.tsx — wizard guiado tenant→room→membership→harness — Gemini (consola)
- console/src/features/config/alta-rapida.test.ts — validaciones del alta rápida con regex — Gemini (consola)
- console/src/features/config/alta-rapida.ts — validación de formularios contra regex de protocolo — Gemini (consola)
- console/src/features/config/areas.test.ts — pruebas del mapa de áreas y su agrupador — Gemini (consola)
- console/src/features/config/areas.ts — mapa de las 7 áreas de configuración y agrupador — Gemini (consola)
- console/src/features/config/arneses.test.ts — cobertura del catálogo de arneses y frases — Gemini (consola)
- console/src/features/config/arneses.ts — catálogo de 4 arneses con su ruta de directiva y dónde se toca — Gemini (consola)
- console/src/features/config/campos-inertes.test.ts — pruebas del catálogo de campos sin efecto — Gemini (consola)
- console/src/features/config/campos-inertes.ts — catálogo de campos sin lector runtime con su cita al código — Gemini (consola)
- console/src/features/config/collection-table.test.ts — pruebas de CollectionTable — Gemini (consola)
- console/src/features/config/collection-table.ts — tabla de colecciones con interruptores y diálogos — Gemini (consola)
- console/src/features/config/collections.test.ts — derivación de colecciones del snapshot — Gemini (consola)
- console/src/features/config/collections.ts — derivación de las colecciones de `/v3/console/config` — Gemini (consola)
- console/src/features/config/config-change.ts — descripción legible de errores de cambio y helper `textoRecarga` — Gemini (consola)
- console/src/features/config/config-receipt.test.ts — validador exacto de la respuesta a `config changes` — Gemini (consola)
- console/src/features/config/config-receipt.ts — guarda de tipo estructural para el recibo de cambios — Gemini (consola)
- console/src/features/config/config-css-toggles.test.ts — pruebas estructurales de los interruptores de config (espec. CSS vs `.metrics-grid.three`) — Gemini (consola)
- console/src/features/config/config-css.test.ts — pruebas de legibilidad CSS de /config (tope, tipos de letra, contraste) — Gemini (consola)
- console/src/features/config/fecha-relativa.test.ts — pruebas de fechas relativas en distintos formatos — Gemini (consola)
- console/src/features/config/fecha-relativa.ts — formateador «hace X / en X» con corte 60 días — Gemini (consola)
- console/src/features/config/Interruptores.test.tsx — pruebas de la lógica de interruptores con control negativo — Gemini (consola)
- console/src/features/config/interruptores.test.ts — pruebas del módulo puro `interruptores.ts` (sin montar ConfigPage) — Gemini (consola)
- console/src/features/config/interruptores.ts — lógica de interruptores con confirmación para `allow_control` — Gemini (consola)
- console/src/features/config/roles.test.ts — cobertura de la lógica de RolesPanel — Gemini (consola)
- console/src/features/config/roles.ts — extracción y render de políticas de rol — Gemini (consola)
- console/src/features/config/use-interruptores.ts — hook que combina snapshot + optimistic + rollback — Gemini (consola)
- console/src/features/fleet/FleetAgentDetailPage.test.tsx — render del detalle de un bot con TUI/PTY — Gemini (consola)
- console/src/features/fleet/FleetAgentDetailPage.tsx — `/fleet/:tenant/:alias`: delega en OperatorWorkspace acotado al bot elegido — Gemini (consola)
- console/src/features/help/HelpPage.tsx — página de ayuda con mapa de vistas, estados y atajos de teclado — Gemini (consola)
- console/src/features/landing/HarnessStrip.tsx — tira plegada con los arneses declarados por el servidor — Gemini (consola)
- console/src/features/landing/JobsRetiredNotice.tsx — aviso para la ruta retirada `/jobs` que señala adónde ir — Gemini (consola)
- console/src/features/landing/LandingPage.permisos.test.tsx — la portada NO duplica el menú lateral — Gemini (consola)
- console/src/features/landing/LandingPage.test.tsx — render de la portada con todas las alertas — Gemini (consola)
- console/src/features/landing/LandingPage.tsx — portada con métricas, alertas agrupadas por vista y tira de arneses — Gemini (consola)
- console/src/features/landing/landing.test.ts — pruebas unitarias del resumider de la portada — Gemini (consola)
- console/src/features/landing/landing.ts — lógica pura del resumen de portada (alertas por destino) — Gemini (consola)
- console/src/features/live/AgentAvatar.tsx — SVG animado por estado (down/blocked/working/idle) — Gemini (consola)
- console/src/features/live/AgentDrawer.tsx — cajón lateral con 7 pestañas (ahora/conexión/entregas/cadena/directiva/perfil/ficheros) — Gemini (consola)
- console/src/features/live/AgentTooltipCard.tsx — tarjeta de tooltip del hipergrafo (4 líneas + pie) — Gemini (consola)
- console/src/features/live/ChainPanel.test.tsx — render de la cadena de delegación con aristas censuradas — Gemini (consola)
- console/src/features/live/ChainPanel.tsx — panel de cadena de delegación con extremos opacos — Gemini (consola)
- console/src/features/live/DirectivaModal.test.tsx — pruebas del modal de directiva (publicado/medido/no-mirado) — Gemini (consola)
- console/src/features/live/DirectivaModal.tsx — modal con las tres capas (rol, manual, memoria) y sus avisos — Gemini (consola)
- console/src/features/live/DirectivaTab.test.tsx — render de la pestaña de directiva — Gemini (consola)
- console/src/features/live/DirectivaTab.tsx — pestaña resumen de directiva con modal a pantalla completa — Gemini (consola)
- console/src/features/live/FicherosTab.test.tsx — render de editor/visor de ficheros con CAS — Gemini (consola)
- console/src/features/live/FicherosTab.tsx — editor/visor de ficheros (CLAUDE.md, AGENTS.md, etc.) con guardado durable — Gemini (consola)
- console/src/features/live/FleetActivityTable.test.tsx — render de la tabla con orden por urgencia y filas truncadas — Gemini (consola)
- console/src/features/live/FleetActivityTable.tsx — tabla de agentes en vuelo con búsqueda por alias y orden por urgencia — Gemini (consola)
- console/src/features/live/FleetVerdict.tsx — banda superior «veredicto de la flota» con culprits clicables — Gemini (consola)
- console/src/features/live/HistorialRol.test.tsx — render del historial de cambios de rol con restauración a borrador — Gemini (consola)
- console/src/features/live/HistorialRol.tsx — diario del rol declarado con puente seguro al editor canónico — Gemini (consola)
- console/src/features/live/LiveFleetLegend.tsx — desplegable de Señales/Permisos/Salas/Estados — Gemini (consola)
- console/src/features/live/LiveFleetPage.filters.test.tsx — pruebas de los filtros (búsqueda/cliente/estado) — Gemini (consola)
- console/src/features/live/LiveFleetPage.sin-salida.test.tsx — render sin ningún dato en vuelo — Gemini (consola)
- console/src/features/live/LiveFleetPage.test.tsx — render completo con el catálogo de mock fixtures — Gemini (consola)
- console/src/features/live/LiveFleetPage.tsx — orquesta `LiveFleetToolbar` + `FleetVerdict` + `Tally` + hipergrafo + tabla + cajón — Gemini (consola)
- console/src/features/live/LiveFleetTally.tsx — cinta de conteo por estado (caído/trabado/…) — Gemini (consola)
- console/src/features/live/LiveFleetToolbar.tsx — barra superior con polling y filtros — Gemini (consola)
- console/src/features/live/LiveHypergraph.tsx — SVG del mapa de flota con nodos, salas, flechas ACL y capa de personas — Gemini (consola)
- console/src/features/live/PerfilTab.test.tsx — render del editor de perfil con guardado governed y ACK exacto — Gemini (consola)
- console/src/features/live/PerfilTab.tsx — editor y preview del perfil canónico del agente (7 campos) — Gemini (consola)
- console/src/features/live/RoleBriefTab.test.tsx — pruebas de la proyección legacy del rol — Gemini (consola)
- console/src/features/live/RoleBriefTab.tsx — proyección de solo-lectura del `role_brief` con puente al editor canónico — Gemini (consola)
- console/src/features/live/activity.test.ts — pruebas de la lógica de actividad (formatos, orden, deduplicación) — Gemini (consola)
- console/src/features/live/activity.ts — etiqueta de work states, deduplicación de señales, formato de ACK — Gemini (consola)
- console/src/features/live/agent-state-derivation.test.ts — derivación de `LiveState` y construcción de la vista — Gemini (consola)
- console/src/features/live/agent-state-helpers.ts — `LiveState` + `LiveAgentView` + aristas agregadas — Gemini (consola)
- console/src/features/live/agent-state.test.ts — pruebas del veredicto, los 7 estados y el pulso de entrega — Gemini (consola)
- console/src/features/live/agent-state.ts — `liveState` (down/blocked/…) y `fleetVerdict` con 3 cubos (problema/ocupado/libre) — Gemini (consola)
- console/src/features/live/capas-pendientes.ts — hueco rotulado de las dos capas que la consola no edita todavía — Gemini (consola)
- console/src/features/live/deriva.test.ts — pruebas de `derivaDelRegistro` (sin registro, sin sala, ambos) — Gemini (consola)
- console/src/features/live/deriva.ts — diferencia simétrica entre `agents` y membresías — Gemini (consola)
- console/src/features/live/directiva.test.ts — pruebas de `avisosDeCapas` con control negativo — Gemini (consola)
- console/src/features/live/directiva.ts — detección de autonomía duplicada y manual abriendo con «Sos…» — Gemini (consola)
- console/src/features/live/directiva-modal/AvisosDeSolapamiento.tsx — caja de avisos de solapamiento de capas — Gemini (consola)
- console/src/features/live/directiva-modal/CapaCabecera.tsx — cabecera de cada capa (icono, número, fuente, ¿por qué?) — Gemini (consola)
- console/src/features/live/directiva-modal/CapasPendientes.tsx — desplegable de huecos «herramientas y prompts» — Gemini (consola)
- console/src/features/live/directiva-modal/ContenidoDeCapas.tsx — cuerpos de las tres capas (manual, memoria) con su medición — Gemini (consola)
- console/src/features/live/estado-de-la-fila.test.tsx — pruebas de coherencia fila ↔ chip del veredicto de la flota — Gemini (consola)
- console/src/features/live/ficheros-legibilidad.test.ts — pruebas de legibilidad CSS de los avisos de ficheros — Gemini (consola)
- console/src/features/live/ficheros.test.ts — pruebas de los motivos de fallo por status HTTP — Gemini (consola)
- console/src/features/live/ficheros.ts — reglas de edición/visualización según `editable`/`projected_fields` — Gemini (consola)
- console/src/features/live/historial-rol.test.ts — pruebas de `entradasMasNuevasPrimero`, `resumirCambio`, `estadoDelDiario` — Gemini (consola)
- console/src/features/live/historial-rol.ts — ordenamiento, resumen y distinción de los 3 desenlaces del diario — Gemini (consola)
- console/src/features/live/live-hypergraph/FlowArrow.tsx — flecha SVG con animación SMIL para delegaciones en vuelo — Gemini (consola)
- console/src/features/live/medicion-de-capa.test.ts — pruebas del discriminante `medido`/`files`/`memory` — Gemini (consola)
- console/src/features/live/perfil-css.test.ts — pruebas estructurales del editor de perfil en móvil/escritorio — Gemini (consola)
- console/src/features/live/perfil.test.ts — pruebas del editor (CAS, topes UTF-16 vs code-points, ACK exacto) — Gemini (consola)
- console/src/features/live/perfil.ts — editor canónico de perfil: 7 campos, topes, ACK de runtime — Gemini (consola)
- console/src/features/live/role-brief-runtime.test.ts — pruebas de la guarda `bloqueoPorRuntimeDesplegado` — Gemini (consola)
- console/src/features/live/role-brief.ts — tope del rol y guarda UTF-16 vs code-points — Gemini (consola)
- console/src/features/live/tira-de-pestanas.test.ts — pruebas del ancho de la tira de pestañas del cajón — Gemini (consola)
- console/src/features/live/veredicto-vocabulario.test.ts — coherencia entre veredicto y chips de la cinta — Gemini (consola)
- console/src/features/live/vocabulario-de-estados.test.ts — tabla de equivalencias work_state→LiveState — Gemini (consola)
- console/src/features/messages/AgentRoster.tsx — lista lateral de agentes con sus pildoras de cola (en cola/curso/reintentos/muertas) — Gemini (consola)
- console/src/features/messages/ConversationPane.tsx — panel de conversación con hilo, detalle completo, compositor anclado — Gemini (consola)
- console/src/features/messages/MessageTimeline.test.tsx — render de la timeline de una entrega — Gemini (consola)
- console/src/features/messages/MessageTimeline.tsx — timeline published→accepted→started→done/failed de una entrega — Gemini (consola)
- console/src/features/messages/MessagesPage.test.tsx — render con mocks: compositor anclado, enlace profundo, fan-out — Gemini (consola)
- console/src/features/messages/MessagesPage.tsx — `/messages` con roster lateral + panel + polling + composer anclado — Gemini (consola)
- console/src/features/messages/composer-anclado.test.ts — pruebas CSS del anclaje del compositor en móvil y escritorio — Gemini (consola)
- console/src/features/messages/desplazamiento.test.ts — pruebas de `irAlFinal`/`estaPegadoAlFinal` con `scrollTo` — Gemini (consola)
- console/src/features/messages/desplazamiento.ts — utilidades de scroll: «ir al final» respetando lo que el operador leyó arriba — Gemini (consola)
- console/src/features/messages/durable-publish.test.ts — pruebas del flujo durable con reconciliación de journal — Gemini (consola)
- console/src/features/messages/durable-publish.ts — flujo de publicación durable con nonce + prepare + confirm + retry — Gemini (consola)
- console/src/features/messages/hilo-legible.test.tsx — tres defectos medidos del hilo (selección fantasma, abre por el viejo, recorte sin etiqueta) — Gemini (consola)
- console/src/features/messages/messages-css.test.ts — pruebas de las clases CSS usadas vs definidas — Gemini (consola)
- console/src/features/messages/publish-receipt.test.ts — pruebas del validador de recibos durables — Gemini (consola)
- console/src/features/messages/publish-receipt.ts — validador de tipo estructural del recibo durable — Gemini (consola)
- console/src/features/messages/queue-health.test.ts — pruebas de `saludDeColaPorAgente` (UNKNOWN vs cero) — Gemini (consola)
- console/src/features/messages/queue-health.ts — fusión de `/v3/console/activity` + `/v3/console/queues` por agente — Gemini (consola)
- console/src/features/messages/roster.test.ts — pruebas del universo ampliado del roster (membresía/registro/mensajes) — Gemini (consola)
- console/src/features/messages/roster.ts — construcción del roster de mensajería con 4 fuentes (topología/registro/mensajes/presencia) — Gemini (consola)
- console/src/features/observability/ObservabilityPage.test.tsx — render con relays auditables y cruce contra audit — Gemini (consola)
- console/src/features/observability/ObservabilityPage.tsx — página «Señales y auditoría» con 2 pestañas y relays al origen — Gemini (consola)
- console/src/features/queues/DeliveryTable.test.tsx — render con replay/cancel y revisión tras 202 sin recibo — Gemini (consola)
- console/src/features/queues/DeliveryTable.tsx — tabla de entregas con replay/cancel tras diálogo de confirmación — Gemini (consola)
- console/src/features/queues/OperationalDlqPanel.test.tsx — paginación keyset del DLQ operativo y reconciliación — Gemini (consola)
- console/src/features/queues/OperationalDlqPanel.tsx — panel del DLQ operativo con paginación, motivos y resolución sin replay — Gemini (consola)
- console/src/features/queues/QueuesPage.test.tsx — pruebas de QueuesPage con 38 filas y filtros — Gemini (consola)
- console/src/features/queues/QueuesPage.tsx — página «Colas y DLQ operativo» con búsqueda, link profundo y DLQ — Gemini (consola)
- console/src/features/queues/colas-accionables.test.tsx — pruebas de los 3 defectos medidos del carrusel de colas (sin filtro, ámbar en done, reinyectar sin confirmar) — Gemini (consola)
- console/src/features/queues/colas-puras.test.ts — pruebas de la lógica de filtro y de `leerUltimoError` — Gemini (consola)
- console/src/features/queues/delivery-receipts.test.ts — pruebas del validador de recibos de replay/cancel — Gemini (consola)
- console/src/features/queues/delivery-receipts.ts — validador de tipo para recibos de replay/cancel — Gemini (consola)
- console/src/features/queues/filtro-de-colas.ts — filtro por grupo (revision/retry/pendientes) y texto libre — Gemini (consola)
- console/src/features/queues/foco-de-entrega.test.ts — pruebas del deep-link `/queues?delivery=` — Gemini (consola)
- console/src/features/queues/foco-de-entrega.ts — deep-link a una entrega específica, con manejo de ausente — Gemini (consola)
- console/src/features/queues/ultimo-error.ts — clasificación «texto»/«sin-error»/«desconocido» por estado de entrega — Gemini (consola)
- console/src/features/terminal/AckInspector.test.tsx — pruebas de la timeline y acciones de replay/cancel — Gemini (consola)
- console/src/features/terminal/AckInspector.tsx — inspector de timeline de una entrega con replay/cancel — Gemini (consola)
- console/src/features/terminal/AdapterInspector.tsx — inspector de permisos, adaptadores y PTY — Gemini (consola)
- console/src/features/terminal/FleetSidebar.tsx — sidebar lateral con leases y chips de capacidad PTY — Gemini (consola)
- console/src/features/terminal/GridContainer.tsx — reja de pestañas de sesiones con repliegue en observación — Gemini (consola)
- console/src/features/terminal/OperatorWorkspace.tsx — workspace con fence de plaza, ciclo de vida PTY y autorización — Gemini (consola)
- console/src/features/terminal/PlazasColgadas.tsx — tira de plazas colgadas con reloj de suelta y `cerrar ahora` — Gemini (consola)
- console/src/features/terminal/PtySessionBar.tsx — barra superior de una sesión PTY abierta (alias/ticket/cuenta atrás) — Gemini (consola)
- console/src/features/terminal/PtySessionDialog.tsx — diálogo de motivo escrito a mano para PTY nueva — Gemini (consola)
- console/src/features/terminal/PtyTerminal.tsx — wrapper React para xterm con reenganche del nodo entre paneles — Gemini (consola)
- console/src/features/terminal/SessionStage.tsx — escenario de una sesión: TUI/PTY/feed, inspección, compositor — Gemini (consola)
- console/src/features/terminal/TerminalPage.test.tsx — render con mocks y avales de PTY — Gemini (consola)
- console/src/features/terminal/TerminalPage.tsx — página del terminal con 6 contadores que se repliegan al abrir sesión — Gemini (consola)
- console/src/features/terminal/TerminalTranscript.tsx — transcript de burbujas in/out con timeline y selección — Gemini (consola)
- console/src/features/terminal/api.test.ts — pruebas del módulo API PTY (timeout, malformed, UNKNOWN inventory, CSRF) — Gemini (consola)
- console/src/features/terminal/api.ts — módulo API PTY: tickets, csrf, inventory, owner takeover — Gemini (consola)
- console/src/features/terminal/cuerpo-del-mensaje.test.ts — pruebas de `textoDelCuerpo` y `previsualizacionRecortada` — Gemini (consola)
- console/src/features/terminal/cuerpo-del-mensaje.ts — constante `CARACTERES_DE_PREVISUALIZACION=240` y lector del body — Gemini (consola)
- console/src/features/terminal/denegaciones.test.tsx — invariantes de los códigos de denegación del gateway — Gemini (consola)
- console/src/features/terminal/denegaciones.ts — traductor de códigos PTY a prosa con `Lo levanta` — Gemini (consola)
- console/src/features/terminal/densidad-observacion.test.tsx — repliegue de los 6 contadores con sesión abierta — Gemini (consola)
- console/src/features/terminal/doctrina.ts — `TEXTO_DOCTRINA` exportado para reusarse en cabecera y footer — Gemini (consola)
- console/src/features/terminal/estilos-en-linea.test.ts — pruebas de no inyección de `<style>` en xterm (CSP) — Gemini (consola)
- console/src/features/terminal/fleet.test.ts — cobertura de la lógica de la flota de terminal — Gemini (consola)
- console/src/features/terminal/fleet.ts — `LiveTuiGate`/`terminalChannelGate`/`fleetTerminalChip`/`leaseStateLabel` — Gemini (consola)
- console/src/features/terminal/live-tui.test.tsx — pruebas de la TUI viva (auto-apertura, controles negativos) — Gemini (consola)
- console/src/features/terminal/nav-availability.test.tsx — pruebas de `terminalNavAvailability` y `configNavAvailability` — Gemini (consola)
- console/src/features/terminal/plazas.test.tsx — pruebas de la trampa del tope de sesiones (cierre, reconciliación, geografía) — Gemini (consola)
- console/src/features/terminal/plazas.ts — `ocupaPlaza`, `plazasOcupadas`, `plazasColgadas`, `minutosParaLiberar` — Gemini (consola)
- console/src/features/terminal/plugin.test.ts — pruebas del gate del plugin y de TUI en vivo — Gemini (consola)
- console/src/features/terminal/plugin.ts — `ultimateTerminalGate`/`terminalChannelGate`/`liveTuiGate` con mismas reglas same-origin — Gemini (consola)
- console/src/features/terminal/pty-connection.ts — ciclo de vida del WebSocket PTY: handshake, resume, control — Gemini (consola)
- console/src/features/terminal/pty-input.ts — cola de input con 8ms de coalesce y `4414` por flood — Gemini (consola)
- console/src/features/terminal/pty-output.ts — escritura de chunks con TextDecoder streaming y worker opcional — Gemini (consola)
- console/src/features/terminal/pty-session.test.ts — pruebas del manager: ticket, control, reconnect, parser DA — Gemini (consola)
- console/src/features/terminal/pty-session.ts — manager externo a React de sesiones PTY: ensurePtySession, attachPtySession — Gemini (consola)
- console/src/features/terminal/pty-socket-stub.ts — doble de WebSocket para tests (cero red) — Gemini (consola)
- console/src/features/terminal/pty-theme.ts — paleta, fuente, `documentoQueNiegaLosEstilos` (override anti-CSP) — Gemini (consola)
- console/src/features/terminal/pty-types.ts — constantes (close codes, MAX_*, `claimReady`), tipos `PtyEntry`/`PtySessionView` — Gemini (consola)
- console/src/features/terminal/redimensionado.test.ts — pruebas de la propagación de `resize` sin SIGWINCH espurios — Gemini (consola)
- console/src/features/terminal/relay-status.test.tsx — pruebas de la clasificación del relay (sin permiso / sin comprobar / no desplegado) — Gemini (consola)
- console/src/features/terminal/relay-status.ts — derivador puro del estado del relay PTY y `useTerminalRelayStatus` — Gemini (consola)
- console/src/features/terminal/session.test.ts — pruebas de `operatorRouteForAgent`, `transcriptForSession`, `formatCountdown` — Gemini (consola)
- console/src/features/terminal/session.ts — ruta de publicación, transcript por sesión, motivo PTY — Gemini (consola)
- console/src/features/terminal/terminal.worker.ts — worker que coalesce chunks PTY a 8 KiB — Gemini (consola)
- console/src/features/terminal/types.ts — `TerminalGrantRequestOutcome` y `RequestTerminalGrant` — Gemini (consola)
- console/src/features/terminal/xterm-csp.css — ⚠ el nombre miente: es el archivo principal de CSS; `@import`s otros tres — Gemini (consola)
- console/src/features/terminal/xterm-csp.test.ts — pruebas estructurales de la hoja CSP de xterm — Gemini (consola)
- console/src/features/topology/AclEdgeList.tsx — lista de aristas ACL con su caption (route/read/control) — Gemini (consola)
- console/src/features/topology/HyperGraph.tsx — hipergrafo SVG con salas (hiperaristas) y aristas ACL — Gemini (consola)
- console/src/features/topology/TenantCards.tsx — tarjetas de tenant con sus salas y miembros — Gemini (consola)
- console/src/features/topology/hypergraph-layout.test.ts — pruebas del layout determinista y no-pisado — Gemini (consola)
- console/src/features/topology/hypergraph-layout.ts — layout del hipergrafo: anclas, relajación, separación, etiquetas — Gemini (consola)
- console/src/features/topology/layout-geometry.ts — geometría: footprint, hash FNV-1a, convexHull, inflateHull, pointInPolygon — Gemini (consola)
- console/src/features/topology/layout-labels.ts — `placeLabels` (etiquetas sin pisarse) y `aclCaption` — Gemini (consola)
- console/src/features/topology/layout-nodes.ts — `collect`, `relax`, `separate`, `anchorEdges`, `arcBetween` — Gemini (consola)
- console/src/lib.test.ts — smoke de `permissionState` y `safe*State` — Gemini (consola)
- console/src/lib.ts — centinelas (`UNKNOWN`, `TODAVIA_NO`, `NO_APLICA`), formateadores y `permissionState` — Gemini (consola)
- console/src/menu-movil.test.ts — pruebas CSS del menú móvil (cuadrícula, `nowrap`) — Gemini (consola)
- console/src/mocks/browser.ts — setupWorker de MSW con ping para mantener vivo el service worker — Gemini (consola)
- console/src/mocks/data.ts — re-exports de los fixtures (topología, actividad, mensajes, colas, cuotas, audit) — Gemini (consola)
- console/src/mocks/fixtures/activity-fixtures.ts — `mockActivity()` con 15 alias, estados variados y aristas de delegación — Gemini (consola)
- console/src/mocks/fixtures/messaging-fixtures.ts — fixtures de status, messages, queues, dlq, adapters, audit — Gemini (consola)
- console/src/mocks/fixtures/quotas-fixtures.ts — `mockQuotas()` con codex/claude/antigravity/opencode — Gemini (consola)
- console/src/mocks/fixtures/topology-config.ts — topología demo: 5 tenants, 15 alias, aristas ACL — Gemini (consola)
- console/src/mocks/handlers.tenant.test.ts — pruebas del mock de perfil/documents tenant-qualified — Gemini (consola)
- console/src/mocks/handlers.ts — handlers MSW para todos los endpoints `/v3/console/*` — Gemini (consola)
- console/src/mocks/server.ts — `setupServer` para tests de Node (vitest) — Gemini (consola)
- console/src/mocks/terminal-demo.test.ts — pruebas de la PTY de mentira (ready fenced, sin trama legacy) — Gemini (consola)
- console/src/mocks/terminal-demo.ts — handlers y WebSocket falso para que la PTY se monte sin backend — Gemini (consola)
- console/src/mocks/terminal-ticket.ts — `mockTerminalGrant`/`mockTerminalTicket` con ticket v1 firmado estructuralmente — Gemini (consola)
- console/src/nav.ts — `NAV_ENTRIES` (8 entradas) y `useNavAvailability` (hook con RBAC + relay) — Gemini (consola)
- console/src/navigation.ts — `navigate`, `redirect`, `onNavClick`, `terminalNavAvailability`, `configNavAvailability` — Gemini (consola)
- console/src/styles.legibilidad-themes.test.ts — pruebas de contraste WCAG 2.1 AA en los dos temas — Gemini (consola)
- console/src/styles.legibilidad.test.ts — pruebas de ancho y de layout móvil — Gemini (consola)
- console/src/styles.tipografia-montada.test.tsx — pruebas del suelo tipográfico sobre vistas montadas — Gemini (consola)
- console/src/styles.tipografia.test.ts — pruebas estructurales de la escala tipográfica — Gemini (consola)
- console/src/vite-env.d.ts — tipos de `import.meta.env.VITE_CAUCE_API_BASE` y `VITE_USE_MOCKS` — Gemini (consola)
- console/src/vocabulario.test.tsx — guardián del vocabulario (sin JSX crudo, sin UNKNOWN, sin ISO cruda) — Gemini (consola)
- console/vite.config.ts — config de Vite: proxy de `/v3`, manual chunks, alias de `@cauce/protocol` — Gemini (consola)

### scripts/ (6)
- scripts/calidad.mjs — gate con trinquete: líneas ≤800 y fechas en comentarios controladas — Codex
- scripts/gancho-de-paquetes.mjs — hook de resolución Node para redirigir `@cauce/*` al árbol local — Codex
- scripts/grafo.mjs — generador determinista de `docs/grafo.md` (aristas + hubs + huérfanos) — Codex
- scripts/paquetes-de-este-arbol.mjs — registra el hook de arriba al iniciar Node — Codex
- scripts/test-all.mjs — orquestador de la matriz de suites (`test:unit`, `test:e2e`, …) — Codex
- scripts/test.sh — wrapper de `pnpm exec vitest run` con detección de red Docker — Codex

### vitest.config.ts (1)
- vitest.config.ts — aliases `@cauce/*` a `packages/<x>/src` y excludes `.claude/worktrees/` — Codex


## D. ops/ + deploy/

### deploy/ (20x)
- deploy/deploy.sh — orquestador FASE 3: build, pin por digest, migrate, up, smoke y registro en HISTORIAL.md (sólo con CAUCE_FASE3_CON_DUENO=si) — Claude+FASE 3
- deploy/fleet-snapshot.mjs — dump JSON read-only de agentes/memberships/role_policies/leases desde PostgreSQL con TLS verificado — Claude+FASE 3
- deploy/liveness-probe.mjs — sonda de PROGRESO (no de respuesta): compara un contador monótono entre dos ejecuciones y falla si lleva stallMs congelado — Claude+FASE 3
- deploy/local-readiness-probe.mjs — probe de readiness restringido al endpoint loopback credential-free /health/ready del gateway — Claude+FASE 3
- deploy/migrate.mjs — wrapper que exige TLS de producción y delega al migrate-cli de packages/store — Claude+FASE 3
- deploy/migration-integrity.mjs — calcula el hash del set de migraciones y exige la 024 + ledger de las 026+ antes/después del deploy — Claude+FASE 3
- deploy/outbox-metrics-core.mjs — exporter Prometheus read-only del outbox: profundidad, edad, DLQ abiertas/nuevas, oldest actionable — Claude+FASE 3
- deploy/outbox-metrics.mjs — servidor HTTP /health/live, /health/ready (que ejecuta las queries reales) y /metrics del outbox y release state — Claude+FASE 3
- deploy/postgres-tls-entrypoint.sh — entrypoint del contenedor postgres: instala server.crt/key/ca.crt en /run/cauce-pg y re-ejecuta docker-entrypoint — Claude+FASE 3
- deploy/postgres-tls.mjs — assertTLS(): rechaza conexiones Postgres sin sslmode=verify-full y PGSSLROOTCERT absoluto (en producción) — Claude+FASE 3
- deploy/readiness-probe.mjs — probe HTTP(S) genérico de /health/ready con carga opcional de DATABASE_URL_FILE y mTLS — Claude+FASE 3
- deploy/reconcile-stale-console-outbox-core.mjs — inspección/aplicación atómica de la reconciliación del outbox legacy de la consola (fence + DLQ) — Claude+FASE 3
- deploy/reconcile-stale-console-outbox.mjs — CLI inspect/pre/apply/post sobre la reconciliación del outbox legacy con confirmación literal — Claude+FASE 3
- deploy/release-state-metrics.mjs — lee el marker durable del release con read-atómico (O_NOFOLLOW+TOCTOU) y emite gauges Prometheus inmutables — Claude+FASE 3
- deploy/runtime-entrypoint.sh — carga DATABASE_URL desde DATABASE_URL_FILE y re-ejecuta el entrypoint del servicio — Claude+FASE 3
- deploy/runtime-package-smoke.mjs — valida manifests, módulos importables, entrypoints presentes y bridges hermes/openclaw dentro de la imagen runtime — Claude+FASE 3
- deploy/schema-version.mjs — imprime la versión más alta de schema_migrations (NNN_nombre.sql) con TLS de producción — Claude+FASE 3
- deploy/smoke-runtime-packaging.sh — construye/arranca postgres efímero y corre el smoke de packaging de runtime con la imagen no-root/read-only — Claude+FASE 3
- deploy/smoke.sh — smoke post-deploy: healthcheck interno del gateway, contenedores healthy, esquema 037, arriendos vivos, bus, sin bucle del relay, ruta de gobierno — Claude+FASE 3
- deploy/unix-readiness-probe.mjs — variante del readiness-probe que habla por Unix socket (HTTP/1.1) — Claude+FASE 3

### ops/pty-agent/ (5x)
- ops/pty-agent/cauce-pty-launcher.sh — launcher: valida config, publica el agente dentro del contenedor root:0555 y lo execa como el usuario del alias — Claude+FASE 3
- ops/pty-agent/cauce_pty_agent.py — agente PTY dentro del contenedor: TLS+wire binario propio hacia el relay, sesión PTY, read/write de gobierno, bus por-sesión, ping/pong — Claude+FASE 3
- ops/pty-agent/derive-alias-key.py — derivación HKDF-SHA256 de la clave PTY por-tenant+alias a partir de la maestra (acepta raw/hex/base64) — Claude+FASE 3
- ops/pty-agent/install-pty-agent.sh — preflight+instalación idempotente de la unit cauce-v3-pty@.service por alias en kratos (no toca adapters) — Claude+FASE 3
- ops/pty-agent/rollout-pty.py — controlador de rollout transaccional a server/kratos con bundle por digest (publica scripts, scripts, agent, unit, launcher) — Claude+FASE 3

### ops/scripts/ (60x)
- ops/scripts/alias-lock-exec.py — adquiere lock de alias en directorio O_NOFOLLOW 0700 y execa un comando heredando el fd (sin shell) — Codex
- ops/scripts/alias-runner.sh — valida env del alias, paths de credenciales, RELAY_URL wss y execa el ejecutable bajo flock(9) — Codex
- ops/scripts/backup.sh — pg_dump custom a /var/backups con sha256, retención de N días y DATABASE_URL_FILE — Codex
- ops/scripts/canary.sh — canary post-cutover: ejecuta el round-trip probe y compara el snapshot con la baseline inmutable — Codex
- ops/scripts/check-postgres-tls.mjs — valida DATABASE_URL(FILE) y exige sslmode=verify-full con PGSSLROOTCERT — Codex
- ops/scripts/compose-files.sh — emite el set autoritativo y ordenado de archivos compose, autenticados por manifest+SHA-256 — Codex
- ops/scripts/compose.sh — wrapper de docker compose que blinda PATH, deshabilita funciones heredadas y exige Docker de sistema — Codex
- ops/scripts/container-adapter-supervisor.sh — supervisor bash de adapters en contenedor: unit, config, bundle, PKI, lock, mount, runtime identity y exec — Codex
- ops/scripts/container-alias-query.py — CLI mínimo: dado un alias imprime las 7 columnas de container-aliases.json separadas por tab — Codex
- ops/scripts/container_alias_lib.py — loader+validador estricto del mapping container-aliases.json (schemaVersion 2, paths canónicos, harness enum) — Codex
- ops/scripts/container_ops_digest.py — calcula el digest sha256 de los inputs y árboles operacionales del supervisor (incluye tests/runbooks críticos) — Codex
- ops/scripts/create-inactive-override-manifest.py — publica un manifest inactivo atómico de overrides YAML con SHA-256, modo 0600 y sin symlinks — Codex
- ops/scripts/cutover.sh — cutover host-native|container bajo flock, requiere CAUCE_CUTOVER_CONFIRM literal y drain snapshot — Codex
- ~~ops/scripts/dlq-list.py~~ — **RETIRO (2026-08-27 ronda 4):** retirada la familia DLQ manual completa (codex la marcó como dudosa en `PENDIENTES-DEL-DUEÑO.md` §(2)(b) y procedió). Ya no existe en `git ls-files`.
- ~~ops/scripts/dlq-reconcile.py~~ — **RETIRO:** igual que arriba.
- ~~ops/scripts/dlq_cli.py~~ — **RETIRO:** igual que arriba.
- ops/scripts/fault-compose.sh — mata y rearranca un servicio (gateway/postgres/telegram-bridge/relay-worker) con CAUCE_FAULT_CONFIRM=ephemeral-only — Codex
- ops/scripts/fault-compose.test.sh — suite bash que ejercita fault-compose.sh con un fake-docker (politica/stack/target) — Codex
- ops/scripts/fleet-watchdog.py — watchdog read-only: heartbeats, leases, dead-letters, deliveries pendientes y unidades systemd (sin escribir) — Codex
- ops/scripts/gate-collector.mjs — captura read-only de los gates de cutover (preflight/drain/canary/watchdog) sobre PostgreSQL — Codex
- ops/scripts/gate-roundtrip-probe.mjs — publica una entrega de gate por mTLS al gateway y deja evidencia efímera 0600 — Codex
- ops/scripts/generate-container-units.py — genera las units systemd de usuario para adapters en contenedor desde container-aliases.json + hermes-runtime.json — Codex
- ops/scripts/generate-telegram-config.py — generador determinista de la config del telegram-bridge (12 alias, allowlists sentinela, chats por grupos) — Codex
- ops/scripts/generate-units.py — genera las units systemd de los adapters a partir de manifests/*.yaml validados — Codex
- ops/scripts/guard-check.sh — watchdog/reconciler gate: captura snapshot y valida contra baseline inmutable — Codex
- ops/scripts/healthcheck.mjs — fetch a /health/ready esperando un campo JSON `status` o boolean — Codex
- ops/scripts/host-backup-monitor.sh — watchdog de staleness: lee status.json del último backup y falla si está ausente, viejo o no-ok — Codex
- ops/scripts/host-backup.sh — orquestador nightly: pg_dump del postgres de prod, opcional ut-nexus SQLite, mirror a nass-stev con manifest — Codex
- ops/scripts/install-cauce-cli.sh — instala los binarios de ops/cli/ en ~/.local/bin, con backup del previo (`torre` o `portatil`) — Codex
- ops/scripts/manifest.sh — genera SHA256SUMS de los artefactos QA/build presentes en un directorio — Codex
- ops/scripts/manifest_lib.py — carga+valida manifests/*.yaml contra el jsonschema con diagnósticos sin exponer valores — Codex
- ops/scripts/migration-gate.mjs — evalúa un snapshot de gates contra umbrales por fase (preflight/drain/canary/rollback/watchdog) — Codex
- ops/scripts/physical-fleet-gate.py — certifica que cada contenedor físico declarado existe en Docker antes de una migración (sólo nombres) — Codex
- ops/scripts/pin-container-release.py — fija BUNDLE_RELEASE/BUNDLE_SHA256 atómicamente preservando el resto del .env del alias — Codex
- ops/scripts/private-postgres-command.py — ejecuta psql/pg_dump/pg_isready con DATABASE_URL por archivo 0600 efímero y service=cauce_restore — Codex
- ops/scripts/provision-alertmanager-config.py — prepara el destino chat-id de Alertmanager reusando el token del bridge (sin imprimir secretos) — Codex
- ops/scripts/provision-hermes-runtime.sh — provisiona/verifica el runtime Hermes fijado bajo /opt, root-owned e inmutable — Codex
- ops/scripts/provision-terminal-client.sh — emite un client cert mTLS (gateway-relay-client o terminal-relay-client) con 0400/0444 sin sobreescribir — Codex
- ops/scripts/quota-collector.py — muestrea ai-usage, mapea a cuentas del panel vía bindings y publica POST /v3/quotas/samples por mTLS — Codex
- ~~ops/scripts/resolve-dlq-without-replay.py~~ — **RETIRO (2026-08-27 ronda 4):** retirada la familia DLQ manual. Ya no existe.
- ops/scripts/run-testcontainers.sh — ejecuta pnpm test:e2e con Testcontainers, valida el set de artefactos y archiva por run-id — Codex
- ops/scripts/separar-config-alias.mjs — planner (no toca disco) de la separación de ~/.codex y ~/.claude por alias en directorios dedicados — Codex
- ops/scripts/smoke-adapter-doubles.sh — build+test del adapter-sdk con los dobles de test (sin invocar el CLI real) — Codex
- ops/scripts/smoke-cli-availability.sh — ejecuta --version/--help aislados de cada CLI de agente (claude/codex/hermes/openclaw/opencode) y reporta — Codex
- ops/scripts/source-digest.py — calcula digests sha256 por dominio (runtime/console/testcontainers/verification/full) sobre paths canónicos — Codex
- ops/scripts/stack-health.sh — health del stack dev|prod vía readiness-probe y docker exec (gateway, console, dispatcher, postgres, telegram-bridge) — Codex
- ops/scripts/systemd-stack.sh — traductor mínimo: dev|test|authentic start|reload|stop → compose.sh up/down -d --wait — Codex
- ops/scripts/telegram-cutover-preflight.py — preflight read-only del cutover del telegram-bridge: schema, mount, token 0600, marker, allowlists — Codex
- ~~ops/scripts/telegram-manual-replay.py~~ — **RETIRO (2026-08-27 ronda 4):** retirada la familia DLQ manual. Ya no existe.
- ~~ops/scripts/telegram-replay-inspect.py~~ — **RETIRO:** igual que arriba.
- ops/scripts/update-alias-config.py — actualiza un <alias>.env atómicamente con flock+CAS+fsync+rename+backup 0600 (sin imprimir valores) — Codex
- ops/scripts/ut-nexus-backup-verify.py — PRAGMA integrity_check + foreign_key_check + conteos sobre un .sqlite de ut-nexus — Codex
- ops/scripts/ut-nexus-backup.py — backup online de la SQLite de ut-nexus vía Connection.backup() (consistente con WAL, sin parar el contenedor) — Codex
- ops/scripts/validate-console-browser-storage.mjs — análisis estático TS: rechaza localStorage/sessionStorage/IndexedDB/caches en console/src — Codex
- ops/scripts/validate-container-mount.py — valida que el state directory del alias cae en un bind/volume RW y no en tmpfs — Codex
- ops/scripts/validate-manifests.py — wrapper mínimo sobre manifest_lib.load_manifests con sys.exit(1) en fallo — Codex
- ops/scripts/validate-testcontainers-evidence.py — valida SHA256SUMS, bindings de source-digest y contrato de la evidencia Testcontainers — Codex
- ops/scripts/validate.sh — gate: bash -n/node --check/compile/python syntax + jsonschema + fleet-size de units generadas y commit de bytes — Codex
- ops/scripts/verify-hermes-runtime.py — verifica que un release sellado de Hermes (.pth, direct_url, hashes) sigue inmutable y dentro del source — Codex
- ops/scripts/verify-manifest.sh — sha256sum -c sobre SHA256SUMS de un directorio de artefactos — Codex

### ops/container-runtime/ (1x)
- ops/container-runtime/cauce-container-runtime.py — supervisor del adapter dentro del contenedor: estado/control dir, identity, exec, lock, metadatos, reap — Claude+FASE 3

### ops/openclaw-gateway/ (1x)
- ops/openclaw-gateway/openclaw-gateway-supervisor.sh — start/stop/status del gateway de OpenClaw dentro del contenedor (mata el árbol por /proc, prueba TCP) — Claude+FASE 3

### ops/console-legibilidad/ (6x)
- ops/console-legibilidad/cdp.mjs — driver CDP mínimo sobre el WebSocket nativo de node 22 (sin puppeteer) — DUEÑO
- ops/console-legibilidad/medir-terminal.mjs — mide geometría y maquetación del panel PTY en Chrome headless (ancho/alto útil, filas, resize) — DUEÑO
- ops/console-legibilidad/medir-tipografia.mjs — mide tamaños de texto bajo el suelo (12,5px) y desbordes reales con Chrome real (jsdom no calcula layout) — DUEÑO
- ops/console-legibilidad/medir.mjs — mide contraste AA calculado con degradados compuestos, opacidad heredada, scrollWidth y recortes de elipsis — DUEÑO
- ops/console-legibilidad/probe.mjs — fuente de la función inyectada vía Runtime.evaluate: parsea color, compone capas y mide contraste WCAG — DUEÑO
- ops/console-legibilidad/servir-con-csp.mjs — servidor HTTPS local que sirve el dist de la consola con la CSP de prod y reenvía /v3/* + WS al gateway real — DUEÑO

### ops/guardias/ (9x)
- ops/guardias/cauce-cuentas.py — alta/baja/reparto de provider_accounts via SQL por ssh a agora-storage (verifica que dos contenedores no apunten al mismo archivo) — Claude+FASE 3
- ops/guardias/cauce-envoltorio-local.sh — wrapper local del CLI `cauce` (ssh a kratos) con `probar` que publica entrega real y mira la TUI mientras corre — Claude+FASE 3
- ops/guardias/cauce-huerfanas.sh — shim de compatibilidad: delega a ops/cli/cauce-huerfanas o al binario instalado (no implementa nada) ⚠ — Claude+FASE 3
- ops/guardias/cauce-kratos.sh — CLI unificado de la flota: listar, attach, ver, on/off, sesión compartida, avisos, probar (publica por el gateway) — Claude+FASE 3
- ops/guardias/contenedor/polidin-fwd.sh — loop ssh -L 0.0.0.0:12222:10.88.88.31:22 hacia kratos (con reconexión) que expone el sshd de la VM polidinámica — Claude+FASE 3
- ops/guardias/cred-guard.py — vigila refresh tokens de claude/codex por contenedor (huella sha256), detecta MUERTO/URGENTE/COMPARTIDA sin tocar archivos — Claude+FASE 3
- ops/guardias/cred-guard.sh — envoltorio de cred-guard.py para systemd (escribe estado y log sin substitution de comandos inline) — Claude+FASE 3
- ops/guardias/hegel-ventas-checkin.py — injector diario por mTLS del check-in de ventas de hegel a POST /v3/messages con idempotency_key por día — Claude+FASE 3
- ops/guardias/polidin-guard.sh — repone el tunel de polidinamica dentro de ws-zeus (setsid+nohup) si dejó de escuchar en 12222 — Claude+FASE 3

### ops/harness/ (4x)
- ops/harness/contract-runner.mjs — runner de contrato end-to-end con WebSocket real contra el gateway (mock o live, --artifact-dir para evidencia) — Codex
- ops/harness/healthcheck.mjs — fetch al /health/ready con timeout 3s y status esperado, falla con exit 1 — Codex
- ops/harness/mock-server.mjs — servidor HTTP in-memory que simula gateway, dispatcher, lanes, DLQ y presence leases para los tests de contrato — Codex
- ops/harness/runner.mjs — runner de contrato contra el gateway REAL (--live) con bindings de source-digest y evidence de testcontainers — Codex

### ops/patches/ (2x)
- ops/patches/apply-openclaw-turn-compaction-guard.sh — orquesta la aplicación del parche a openclaw por docker exec o --local, reporta por objetivo sin interrumpir — Codex
- ops/patches/openclaw-turn-compaction-guard.mjs — envuelve runCliTurnCompactionLifecycle en try/catch con log.warn; idempotente, valida con node --check antes de escribir — Codex



## E. Tests — una línea por suite

Las suites co-localizadas bajo `src/` (p. ej. `services/gateway/src/*.test.ts`, `console/src/**/*.test.tsx`) ya están descritas en las secciones A–D. Aquí van las suites independientes.

### packages/adapter-sdk/test/ (39 ficheros)
Suite del SDK adaptador (tmux, durable store, engine, harnesses, session turn-merge). Sectores: Codex.

### packages/protocol/test/ (4 ficheros)
- `packages/protocol/test/ficheros-del-arnes.test.ts` — valida el reparto de secciones del perfil entre CLAUDE/AGENTS/openclaw — Codex (protocol)
- `packages/protocol/test/ficheros-que-no-mienten.test.ts` — invariantes de nombres honestos en el árbol — Codex (protocol)
- `packages/protocol/test/priority.test.ts` — bandas y clamp de prioridad — Codex (protocol)
- `packages/protocol/test/schemas.test.ts` — round-trip Zod del wire 3.0 — Codex (protocol)

### packages/store/test/ (52 ficheros)
Suite del store PostgreSQL (deliveries, fan-in, agents, dlq, quotas, console publish). Codex.

### services/dispatcher/test/ (3 ficheros)
Smoke del dispatcher: handlers de job, scheduler fair-lane, lease reaping. Codex.

### services/telegram-bridge/test/ (20 ficheros)
Suite del bridge Telegram (poller, DLQ manual, reconciliación, replays). Gemini (canales).

### tests/integration/ (4 ficheros — TODOS los del Tarea 1)
- `tests/integration/vertical.test.ts` — slice vertical PostgreSQL + HTTP + WebSocket (18 tests, 248 s) — Codex (gateway)
- `tests/integration/mcp-fleet-monitor-tools.test.ts` — herramientas del MCP fleet-monitor (6 tests) — Codex (mcp)
- `tests/integration/otel-collector-config.test.ts` — pinning del OpenTelemetry Collector 0.130.1 (2 tests) — Codex
- `tests/integration/busybox-console-healthcheck.test.ts` — healthcheck de consola bajo BusyBox (1 test) — Codex

### tests/e2e/ (2 ficheros)
- `tests/e2e/console-login.test.ts` — login end-to-end de la consola — Gemini (consola)
- `tests/e2e/real-qa.test.ts` — QA real con harness (gated) — Gemini (consola)

### tests/gateway-hardening/ (17 ficheros + helpers)
Suite pesada de hardening del gateway (delivery admission, terminal ACK replay, wake-outbox, cuotas, websocket correlation, security, identity rotation). Codex. **2 rojos históricos** (sector Codex): `wake-outbox-routing.test.ts` (ackOutbox applied=false) y `perfil-en-el-saludo.test.ts` (lee app.ts como texto; el contrato vive ahora en `routes/core.ts`).

### tests/store-hardening/ (9 ficheros)
Suite pesada de store con testcontainers PostgreSQL real (adversarial, agent-registry, oidc-session, quota-ingest, terminal-admission, account-selector, configuration, gate-collector, role-brief). Codex. **20 rojos en 5 ficheros** (post-revisión 26-ago): 5 son preexistente del setup `terminal-relay-instance-fencing-migration-postgres.test.ts` que baja 036 (la guarda anti-downgrade de la 037 lo rechaza).

### tests/terminal-pty/ (5 ficheros + 3 helpers)
Suite del contrato PTY-relay (relay-contract-agent, relay-contract-lifecycle, relay-contract, presence-contract, vectors) + fakes (certs, fake-gateway, fake-pty-agent, protocol). Gemini (canales).

### tests/unit/ (40 ficheros)
Suite unitaria global: protocol-runtime, scheduler, migrate-cli-production, runtime-package-smoke, dockerfile-runtime-policy, host-backup-monitor, postgres-tls-policy, topes-de-delegacion-editables, observability-alerting, etc. Codex (la mayoría).

### ops/tests/ (26 ficheros)
Mezcla de tests de ops-scripts (alias-runner, container-cutover, container-supervisor, gate-collector, provision-hermes-runtime, separar-config-alias, source-digest-domains, update-alias-config, container-runtime-reaping/zombies, fleet-watchdog, provision-alertmanager, quota-collector, schema-error-sanitization, verify-hermes-runtime, alias-lock-exec, config-por-alias-supervisor) + helpers/fakes (fake-{container-supervisor,docker,gate-collector,gate-roundtrip-probe,systemctl}.mjs) + fixtures (account-bindings, ai-usage, fake_quota_server). Codex mayoritario; `container-supervisor.test.mjs` (1761 líneas, DUEÑO per `minimax-foto-final.md`).

### ops/pty-agent/tests/ (≈3 ficheros)
Tests Python del agente PTY: test_read_governance.py (852 líneas, Claude+FASE 3) y otros. Suite viva.
