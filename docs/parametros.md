# Parámetros del orquestador

Tabla única: cada parámetro que gobierna el sistema con unidad, fuente y valor
vigente. Verificada contra el árbol `dev` (`8583c565`). La sonda
`tests/unit/parametros.test.ts` (T015) falla si aparece un parámetro en código
sin fila aquí. Lo que falta medir es pregunta abierta al final, no invención.

Fuente: `medido` = hecho de runtime por alias; `env` = variable con defecto;
`DB` = fila/tabla; `fijo` = constante; `dueño` = solo el dueño lo fija.

## 1. Presupuestos de contexto por harness

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| `PRESUPUESTOS_DE_CONTEXTO` (`packages/protocol/src/ficheros-del-arnes.ts:296`) | mixto (ver filas) | claude/codex/hermes/openclaw | fijo (tabla única) | e2e + unit perfil |
| claude: unidad | UTF-16 strictest | sin topes (rige techo nativo 4 MiB) | fijo (decisión dueño: solo techo nativo) | — |
| codex: `TOPE_CODEX_POR_DEFECTO_BYTES` (`:291`, alias gateway `DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES`) | bytes UTF-8 | 32_768 (32 KiB) | fijo (defecto; `measured` de `project_doc_max_bytes` lo sobrescribe) | e2e + unit perfil |
| codex: `MAX_CODEX_PROJECT_DOC_BYTES` (`governance-documents.ts:23`), `MAX_CODEX_PROJECT_DOC_FALLBACKS`=16 | bytes/n | 16 MiB | fijo (techo absoluto del medido) | — |
| codex: `CLAVE_DEL_TOPE` = `project_doc_max_bytes` (`:329`) | — | clave TOML raíz del alias | fijo | — |
| hermes: unidad | UTF-16 | sin topes | fijo (decisión dueño: solo techo nativo) | — |
| openclaw: `TOPES_OPENCLAW` (`:276`) | UTF-16 strictest | 90_000/fichero, 200_000 total | fijo (DENTRO del contenedor, sin BD) | e2e + unit perfil |
| `AGENT_PROFILE_LIMITS.total` (`agent-profile.ts:35`) | strictest | 24_000 | fijo | unit perfil |
| `AGENT_PROFILE_LIMITS` campos (`:25-33`) | strictest/entradas | purpose 2_000, role_summary 4_000, human_brief 2_000, item 1_000, items 64 | fijo | unit perfil |
| `ROLE_BRIEF_MAX_CODE_POINTS` (`schemas/core.ts:39`) | code points | 1_200 | fijo | — |
| Documentos de gobierno por arnés (`:426`) | rutas | claude→CLAUDE.md, codex/hermes→AGENTS.md, openclaw→7 ficheros | fijo | — |
| `MAX_RUTA_DE_GOBIERNO` (`:445`) | chars | 4_096 | fijo | — |

Discrepancia: el árbol dice 90K/200K para openclaw; `docs/roadmap.md` (30-08)
dice 60K/150K. Manda el árbol; el roadmap se re-verifica en T063.

## 2. Leases, ACK y fencing

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| `DEFAULT_ACK_DEADLINE_MS` (`store/delivery-timing.ts:5`) | ms | 30_000 | fijo, override `CAUCE_ACK_DEADLINE_MS` (test: 50) | e2e 14/14 |
| `leaseTtlMs` (`gateway/config.ts:7`, `DEFAULT_LEASE_TTL_MS`, `MIN_LEASE_TTL_MS`) | ms | 180_000, mín 30_000 | `CAUCE_LEASE_TTL_MS` | e2e |
| `CAUCE_REQUIRE_ACK_CLAIMS` (`gateway/main.ts:222`) | bool | true (prod `false` aborta boot) | env | — |
| `CAUCE_DELIVERY_LEASE_CAP_GRACE_MS` (`store/delivery-timing.ts:37`) | ms | = gracia 30 min | env | — |
| `resumeWindowMs` (`gateway/routes/core.ts:363`) | ms | = ackDeadline | fijo (derivado) | e2e |
| `DEFAULT_DELIVERY_LEASE_CAP_MS` (`store/.../policy.ts:5`) | ms | 43_200_000 (12 h) | fijo + `CAUCE_DELIVERY_LEASE_CAP_MS` | — |
| `DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS` (`:8`) | ms | 1_800_000 (30 min) | fijo + env | — |
| `DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS` (`:11`) | ms | 86_400_000 (24 h) | fijo + runtime | e2e (DLQ) |
| `connection_token` | UUID | rota en cada hello, incluso resume | medido (PG) | e2e (fencing) |
| `claimDeliveries` limit/deadline/burst (`claims.ts:213`) | filas/ms/racha | 20 / 30_000 / 3 | fijo (caller pisa) | e2e |
| `maxClaims` (`:222`) | filas | min(100, limit+reserva), rango 1–100 | fijo + runtime | — |
| `liveDeliveryClaims` (`:512`) | filas | 256 | fijo | — |
| `lock_timeout` en claims (`:241`) | ms | 85_000 | fijo | — |
| `agents.max_concurrent_deliveries` (DB) | entregas | 1–100 o NULL = sin tope | DB (validado fijo) | e2e |
| WS cierre | código | 4401 fenced, 4403 no declarado, 4409 takeover, 1011, 1001 | fijo | e2e |

## 3. Backoffs y reintentos

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| `timeoutRetryBackoffSeconds` (stale, `policy.ts:210`) | s | base 30, cap 300 | fijo (deliberado, por incidente) | `compose-test-stack` (contrato) |
| `ackFailureBackoffSeconds` (`:214`) | s | base 1, cap 60 | fijo | — |
| `jobRetryBackoffSeconds` (`:218`) | s | base 1, cap 300 | fijo | — |
| `retry_after_ms` outbox (`settlement.ts:79`) | ms | 250 | fijo | — |
| `CAUCE_RETRY_TIMEOUT_MS` (arnés) | ms | 45_000 (test) | `ops/compose.test.yaml` (cubre el backoff de 30 s) | `compose-test-stack` (contrato) |
| `retryStaleDeliveries` batch (`maintenance.ts:57`) | filas | 100 | fijo | e2e (DLQ) |
| `retryStartedDeliveries` / `parkWithoutConsumer` (`:62`, `CAUCE_RETRY_STARTED_DELIVERIES`) | bool | false / true | runtime | — |

## 4. Admisión gateway y drenaje

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| `CAUCE_MAX_INFLIGHT_DELIVERIES` (`gateway/config.ts:29`, `DEFAULT_MAX_INFLIGHT_DELIVERIES`) | slots | 2 | env (ambos a 0 = error de arranque) | — |
| `CAUCE_HUMAN_RESERVED_DELIVERIES` (`:35`, `DEFAULT_HUMAN_RESERVED_DELIVERIES`) | slots | 2 | env | — |
| `deliveryClaimLimit` (`app.ts:183`, `DEFAULT_DELIVERY_CLAIM_LIMIT`) | entregas | 20, rango 1–100 | código llamante | e2e |
| `GATEWAY_WS_MAX_PAYLOAD_BYTES` (`:186`) | bytes | 16 MiB | fijo | — |
| `MAX_DRAIN_ROUNDS` (`helpers.ts:14`) | rondas | 16 | fijo | — |
| `MAX_REHYDRATED_CLAIMS` (`:13`) | claims | 256 | fijo | — |
| `MAX_RECENT_SESSION_CLAIMS` (`:7`) | claims | 1_024 (LRU) | fijo | — |
| `outboxPollMs` / `outboxLeaseMs` / workers (`app.ts:218`, `DEFAULT_WAKE_PUMP_CONCURRENCY`, `DEFAULT_OUTBOX_SHUTDOWN_TIMEOUT_MS`=1_000) | ms/ms/n | 100 / 30_000 / 4 (1–32) | código llamante | — |
| `pendingSweepMs` (`app.ts`, `DEFAULT_PENDING_SWEEP_MS`) — barrido de pendientes sin wake (hold liberado o caducado, fila saltada, NOTIFY perdido) | ms | 2_000, rango 0–60_000 (0 = apagado) | código llamante | gateway-hardening/pending-sweep + store redrain-pendiente-postgres |
| `bodyLimit` publish (`publish.ts:43`) | bytes | `MAX_PUBLISH_BODY_BYTES` ≈ 13,6 MB | protocolo (exceder → 413) | e2e |
| `QueryDeliveries` limit (`realtime.ts:130`) | filas | 1–100, defecto 20 | fijo | — |

## 5. Terminal, relay y PTY

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| `CAUCE_TERMINAL_TICKET_TTL_SECONDS` (`DEFAULT_TICKET_TTL_SECONDS`, `MAX_TICKET_TTL_SECONDS`) | s | 30, máx 120 | env | e2e terminal |
| `CAUCE_TERMINAL_SESSION_TTL_SECONDS` (`DEFAULT_SESSION_TTL_SECONDS`, `MAX_SESSION_TTL_SECONDS`) | s | 900, máx 3_600 | env | — |
| `CAUCE_TERMINAL_SESSION_MAX_TOTAL_SECONDS` (`DEFAULT_SESSION_MAX_TOTAL_SECONDS`, `MAX_SESSION_MAX_TOTAL_SECONDS`) | s | 3_600, máx 14_400 | env | — |
| `CAUCE_TERMINAL_CLAIM_LEASE_SECONDS` (`DEFAULT_CLAIM_LEASE_SECONDS`, `MAX_CLAIM_LEASE_SECONDS`, `MIN_CLAIM_LEASE_SECONDS`) | s | 150, rango 131–300 | env | — |
| `CAUCE_TERMINAL_CONTROL_HOLD_SECONDS` (`DEFAULT_CONTROL_HOLD_SECONDS`) | s | 900 | env | — |
| `CAUCE_TERMINAL_MAX_SESSIONS_PER_OPERATOR` (`DEFAULT_MAX_SESSIONS_PER_OPERATOR`) | sesiones | 2, máx 64 | env | — |
| `CAUCE_TERMINAL_RW_ENABLED` + `CAUCE_TERMINAL_OPERATORS` + `CAUCE_TERMINAL_ENABLED` | flag/lista | off / vacío / requerido `=1` | env + FR (kill switch) | — |
| `CAUCE_TERMINAL_WS_PATH` (`DEFAULT_TERMINAL_WS_PATH`), `CAUCE_TERMINAL_OPERATOR_HEADER` (`DEFAULT_OPERATOR_HEADER`), `CAUCE_TERMINAL_GRANTS_FILE` (`DEFAULT_TERMINAL_GRANTS_FILE`), `CAUCE_TERMINAL_RELAY_URL`, `CAUCE_TERMINAL_RELAY_INSTANCE_ID`, `CAUCE_TERMINAL_RELAY_INSTANCE_IDS` | ruta/header | ws `/v3/console/terminal/ws`, header `x-cauce-operator`, grants `/run/cauce-terminal/grants.json`, relay HTTPS, IDs 64 hex | env | — |
| `DEFAULT_RELEASE_REASON` (`session-control/control.ts:30`) | — | `'operator_released'` | fijo | — |
| `MAX_FRAME_PAYLOAD_BYTES` (`terminal-relay/.../framing.ts:57`) | bytes | 65_536 | fijo (tag inválido corta TODO) | e2e |
| `AGENT_STALE_AFTER_MS` (`gateway/terminal/registry.ts:11`) | ms | 45_000 | fijo | — |
| `MAX_TERMINAL_CLOCK_SKEW_MS` (`session-control.ts:34`) | ms | 5_000 | fijo | — |
| `MAX_SECONDS` (`terminal/authority-continuity.ts`) | s Unix | 8_640_000_000_000 | límite fijo de representación temporal de la autoridad; no amplía la vigencia original | unit autoridad |
| `CONTROL_HOLD_MAX_WINDOW_MS` (`store/.../terminal-control-holds.ts:10`) | ms | 12 h | fijo (= migración 040) | — |
| `MAX_JOURNAL_PAGE` / `MAX_JOURNAL_PATH` / `MAX_JOURNAL_ID` | filas/chars/int | 200 / 4_096 / int64 máx | fijo | — |
| Ticket ≤4_096 chars, resume 80–1_024 | chars | — | fijo | — |
| `CAUCE_TERMINAL_RECORDING_DIR` + `RECORDING_RETENTION_MS` (`recording-retention.ts`) | ruta/ms | dir + 30 días (2_592_000_000) | env + fijo (FR-012) | unit sweeper |
| `CAUCE_BLOB_API_ENABLED` (`config.ts:configuredBlobApi`) | flag | `0` por defecto; solo `1` registra PUT/GET de blobs | env | unit blobs + gate de despliegue |
| `CAUCE_BLOB_DIR` (`config.ts:configuredBlobStore`, defecto `DEFAULT_BLOB_DIRECTORY`) | ruta absoluta | `/var/lib/cauce-v3/blobs`; por sí sola no activa rutas | env + fijo | unit blobs + pg |
| `CAUCE_BLOB_MAX_BYTES` (`config.ts`, tope `MAX_BLOB_BYTES` 16 GiB) | bytes | 2 GiB (`DEFAULT_BLOB_MAX_BYTES`), entero 1–16 GiB | env + fijo | unit blobs |

## 6. Auth, consola y secretos

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| `CAUCE_CONTEXT_INSTANCE_ID` (`gateway/console/context-repository/binding.ts`) | identidad | sin default; requiere también la raíz, ambas ausentes desactivan la inspección | env del servidor | unit binding + rutas |
| `CAUCE_CONTEXT_REPOSITORY_ROOT` (`gateway/console/context-repository/binding.ts`) | ruta absoluta | sin default; raíz canónica confiable de un repo con objetos sueltos, sin packs, alternates ni worktrees enlazados | env del servidor, junto con la identidad | unit binding + inspección Git |
| `CAUCE_CONSOLE_SESSION_TTL_SECONDS` (`DEFAULT_SESSION_TTL_MS`=8 h) | s | 28_800 (8 h), rango 60–86_400 | env | — |
| Login throttle | intentos | 8 fallos / 15 min / 10_000 claves | fijo | — |
| scrypt (`DEFAULT_SCRYPT_COST`, `DEFAULT_SCRYPT_BLOCK_SIZE`, `DEFAULT_SCRYPT_PARALLELISM`, `MAX_MEMORY`=96 MiB) | N/r/p | 32_768 / 8 / 1; clave 32 B, salt 16 B | fijo | — |
| Contraseña (`MIN_PASSWORD_LENGTH`, `MAX_PASSWORD_LENGTH`) | chars | 12–1_024 | fijo | — |
| `CAUCE_AUTH_PROVIDER`, `CAUCE_CONSOLE_PASSWORD_FALLBACK` | enum | `mtls` (fallback token-file/none) | env | — |
| `CAUCE_MCP_PUBLIC_ORIGIN` | origen | sin default; origen HTTPS exacto, sin ruta, query, fragmento ni credenciales; la audiencia MCP deriva `{origen}/mcp` | env público, no secreto | arranque MCP |
| `CAUCE_MCP_OAUTH_ISSUER` | URL | sin default; emisor HTTPS exacto esperado en el token | env público, no secreto | arranque MCP |
| `CAUCE_MCP_OAUTH_JWKS_URI` | URL | sin default; endpoint HTTPS fijo de claves públicas, sin query, fragmento ni credenciales | env público, no secreto | arranque MCP |
| `CAUCE_MCP_OAUTH_PROVIDER` (`gateway/main.ts:configuredLocalOAuth`, `gateway/mcp-configuration.ts`) | enum | ausente = modo externo (issuer/JWKS); `local` = servidor de autorización propio, exige `CAUCE_AUTH_PROVIDER=password` y prohíbe `CAUCE_MCP_OAUTH_JWKS_URI` | env público, no secreto | arranque MCP + gate de despliegue |
| `CAUCE_MCP_OAUTH_SIGNING_KEY_FILE` (`gateway/main.ts:configuredLocalOAuth`) | ruta en el contenedor | sin default; clave privada EC P-256 PKCS8 sin cifrar del AS local, solo con `CAUCE_MCP_OAUTH_PROVIDER=local` | env del servidor (ruta a secret montado) | arranque MCP |
| `CAUCE_MCP_OAUTH_SIGNING_KID` (`gateway/main.ts:configuredLocalOAuth`) | string | sin default; `kid` publicado en el JWKS del AS local | env público, no secreto | arranque MCP + gate de despliegue |
| `CAUCE_MCP_OAUTH_GRANT_TTL_SECONDS` (`gateway/main.ts:configuredLocalOAuth`, `OAUTH_GRANT_TTL_SECONDS`) | s | 2_592_000 (30 días), rango 300–2_592_000; vida fija del grant del AS local desde el consentimiento, independiente de la cookie de consola; el refresh token nunca pasa de ella; solo con `CAUCE_MCP_OAUTH_PROVIDER=local`. El overlay de despliegue aún fija 28_800 si el integrador no configura otro valor | env público, no secreto | arranque MCP |
| `CAUCE_MCP_OAUTH_SIGNING_KEY_PATH` (`deploy/compose.mcp-human-local.yaml`, `deploy/deploy.sh`) | ruta en el host | sin default; origen del secret Compose `mcp_oauth_signing_key` (uid/gid 1000, modo 0400); generarla con `deploy/mcp/generate-oauth-signing-key.sh` | env de despliegue, nunca en `prod.env` | gate de despliegue |
| OIDC sesión/login/leeway | ms | 8 h / 10 min / 30 s | código | — |
| JWKS cache/tolerancia | ms/s | 300_000 / 30 | código | — |
| `SECRET_HANDOFF_MAX_TTL_MS` (`protocol/sealing.ts:23`, `MIN_HANDOFF_TTL_MS`=30_000) | ms | 86_400_000 (24 h) | fijo | — |
| `MAX_SECRET_PLAINTEXT_BYTES` / label / sealed (`:24-32`, `MAX_SECRET_LABEL_LENGTH`, `MAX_SEALED_BYTES`, `MAX_HANDOFF_INSTANT_BYTES`=64) | bytes/chars | 65_536 / 120 / 65_600 | fijo | — |
| Topes handoff (`secret-handoff/store.ts:102`, `MAX_SEALING_KEYS_PER_ALIAS`=8, `MAX_HANDOFFS_PER_RECIPIENT`=32, `MAX_PENDING_HANDOFF_PAGE`=20) | uds | 8 claves/24 h, 32/receptor/24 h, página 20, gracia 15 min, prune 200 | fijo | — |
| Denegaciones (`audit.ts:63`, `MAX_DENIAL_REASONS_PER_WINDOW`, `MAX_TRACKED_SENDERS`, `MIN_SIGNING_KEY_BYTES`) | ms/uds | ventana 60_000, 512 senders, 8 reasons | fijo | — |
| Publish intents (`store/.../publish-policy.ts:15`, `MAX_OPEN_CONSOLE_PUBLISH_INTENTS`, `MAX_NEW_CONSOLE_PUBLISH_INTENTS_PER_TEN_MINUTES`, `MAX_NEW_CONSOLE_PUBLISH_INTENTS_PER_DAY`) | intents | 32 abiertos; 60/10 min, 200/día; stale 15 min | fijo | — |
| `wakePumpMaxStaleMs` (`health.ts:269`) | ms | 60_000 | código (503 si se excede) | e2e (ready) |
| Lectura gobernanza (`DEFAULT_TIMEOUT_MS`=10 s, `MAX_RESPONSE_BYTES`, `MAX_DOCUMENT_BYTES`, `MAX_DIRECTORY_ENTRIES`, `MAX_PATH_BYTES`, `MAX_DATE_BYTES`, `MAX_REASON_BYTES`, `MAX_MEMORY_PATH_BYTES`, `MAX_MEMORY_DATE_BYTES`, `MAX_MEMORY_DIRECTORY_ENTRIES`, `MAX_SCANNED_EXPECTATIONS`=500) | bytes/n | doc ≤256 KiB, dir ≤200, path ≤4_096, fecha ≤64, reason ≤2_048 | fijo | — |
| Auditoría resumen (`MAX_FIELDS`=10, `MAX_TEXT`=180) y paginación (`DEFAULT_PAGE`, `MAX_PAGE`) | n/chars | allowlist de metadata | fijo | — |
| Puertos (`PORT`, `CAUCE_HEALTH_PORT`, `CAUCE_CONSOLE_ORIGINS`) | — | datos 8080, health 8081 (≠), consola 8444 | env | e2e |
| Redacción (`MAX_SCANNED_CHARACTERS`, `MAX_RULE_MATCH_CHARACTERS`, `MAX_SCANNED_VALUE_CHARACTERS`, `MAX_SCANNED_NODES`, `MAX_SCANNED_TOTAL_CHARACTERS`) | chars/nodos | ventana 256 KiB, match 20 KiB, valor 1 MiB, nodos 100 K, total 4 MiB | fijo | e2e redaction |
| `CAUCE_REDACT_PUBLISH` | bool | true | env | — |

El MCP humano permanece desactivado si ninguna de las dos familias de variables está presente.
Modo externo: las tres variables `CAUCE_MCP_PUBLIC_ORIGIN`/`CAUCE_MCP_OAUTH_ISSUER`/`CAUCE_MCP_OAUTH_JWKS_URI`.
Modo local: `CAUCE_MCP_OAUTH_PROVIDER=local` junto con `CAUCE_MCP_PUBLIC_ORIGIN`,
`CAUCE_MCP_OAUTH_SIGNING_KEY_FILE` y `CAUCE_MCP_OAUTH_SIGNING_KID`, sin `CAUCE_MCP_OAUTH_JWKS_URI`.
Una configuración parcial, mezclada entre ambos modos o con una URL inválida hace abortar el
arranque antes de crear el pool PostgreSQL. El despliegue selecciona el overlay Compose
correspondiente (`deploy/compose.mcp-human.yaml` o `deploy/compose.mcp-human-local.yaml`)
según `CAUCE_MCP_OAUTH_PROVIDER` en `deploy/deploy.sh`.

## 7. Retención, GC y poda

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| ACKs renovación / general (`policy.ts:101-108`, `DEFAULT_RETENTION_ACK_RENEWAL_MS`, `DEFAULT_RETENTION_ACK_MS`, `CAUCE_RETENTION_ACK_RENEWAL_MS`, `CAUCE_RETENTION_ACK_MS`) | ms | 6 h / 14 días | fijo + runtime | — |
| Auditoría renovación / general (`:111-118`, `DEFAULT_RETENTION_AUDIT_RENEWAL_MS`, `DEFAULT_RETENTION_AUDIT_MS`, `CAUCE_RETENTION_AUDIT_RENEWAL_MS`, `CAUCE_RETENTION_AUDIT_MS`) | ms | 6 h / 30 días | fijo + runtime | — |
| `DEFAULT_RETENTION_BATCH` (`:149`, `CAUCE_RETENTION_BATCH`, `DEFAULT_RETENTION_INTERVAL_MS`, `CAUCE_RETENTION_INTERVAL_MS`) | filas | 5_000 | fijo + runtime | — |
| `DISPOSABLE_AUDIT_ACTIONS` (`:146`) | lista | `['delivery.ack']` (sin env a propósito) | fijo | — |
| Strip adjuntos (`message-body-retention.ts:5`, `DEFAULT_MESSAGE_ATTACHMENT_PRUNE_BATCH`, `DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_MS`, `DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS`, `DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_BATCH`) | ms/filas | 30 días / batch 50 | fijo + runtime | — |
| `dead_letters` | — | sin poda (solo strip de bytes) | fijo (diseño) | — |
| Dispatcher (`DISPATCHER_POLL_MS`=250, `ACK_TIMEOUT_MS`/`DEFAULT_ACK_TIMEOUT_MS`=30_000, `CAUCE_DISPATCHER_STALE_MS`, `DEFAULT_CHAIN_SWEEP_MS`=60 s, `DEFAULT_CHAIN_IDLE_MS`=6 h, `DEFAULT_CHAIN_SETTLED_GRACE_MS`=15 min, `DEFAULT_CHAIN_MAX_AGE_MS`=48 h, `DEFAULT_CHAIN_SWEEP_LIMIT`=5, `DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_MS`, `DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS`, `DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_BATCH`) | ms | — | env + fijo (test: poll 20, ACK 50) | e2e |
| Cuotas: retención 30 días, LIMIT 500 (`quotas.ts:651`) | intervalo/filas | — | fijo (SQL) | — |

## 8. Cuotas y actividad de flota (umbrales)

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| `stale_after_seconds` / warn / critical (`quotas.ts:22`, `DEFAULT_QUOTA_THRESHOLDS`) | s/%/% | 900 / 25 / 10 | fijo | — |
| `history_window_seconds` / bucket / puntos | s/s/n | 86_400 / 1_800 / 48 | fijo | — |
| `MAX_QUOTA_WINDOWS_PER_COLLECTION` (`quotas.ts:74`) | ventanas | 512 | fijo | — |
| `saturation_in_flight` / `stall_after` / `start_after` (`fleet-activity.ts:18`, `DEFAULT_FLEET_ACTIVITY_THRESHOLDS`) | n/s/s | 8 / 300 / 60 | fijo | — |
| `ROLE_BRIEF_MAX_CODE_POINTS` | code points | 1_200 | fijo | — |

## 9. Delegación, cadena y fan-in

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| `DEFAULT_DELEGATION_CAPS` (`delegation-guard.ts:30`) | — | fanout 6, edgeRepeats 3, perRoot 64 | fijo (= migración 019) | e2e (ACL) |
| Hop budget / path (`chain-control/policy.ts:31`) | saltos | 16 | fijo | — |
| Outputs por ACK (`contracts.ts:123`) | n/bytes | 100 msgs / 64 KiB body / 256 KiB agregado | fijo | — |
| Notify por ACK (`:126`) | n/bytes | 4 directivas / 8 KiB | fijo | — |
| Fan-in (`fanin/helpers.ts:6`) | bytes | 4 KiB/respuesta, 64 KiB agregado | fijo | — |
| `MAX_DELEGATION_FEEDBACK_ITEMS` (`realtime.ts:231`) | items | 1_000 | fijo | — |
| Gate humano: pregunta ≤8 KiB, gate_id ≤128 | bytes/chars | — | fijo (= CHECK SQL) | — |
| Rechazo delegación (`MAX_DELEGATION_REJECTION_TARGET_CHARS`=256, `MAX_DELEGATION_REJECTION_REASON_CHARS`=12_000) | chars | target copiado, reason acotada | fijo | — |
| `failureCoalesceWindowSeconds` | s | clamp 0–86_400 | DB (techo fijo) | — |

## 10. Adjuntos y protocolo wire

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| `MAX_ATTACHMENT_BYTES` / `MAX_ATTACHMENTS_TOTAL_BYTES` / `MAX_ATTACHMENTS_PER_MESSAGE` / `MAX_ATTACHMENT_MEDIA_TYPE_LENGTH`=127 / `MAX_ATTACHMENT_NAME_LENGTH`=255 (`attachment-limits.ts:1`) | bytes/n | 10 MB / 10 MB / 4 | fijo | e2e |
| Artefactos (`MAX_ARTIFACTS_CONSIDERED`=16, `MAX_ARTIFACT_LOCATOR_CHARACTERS`=2048, `MAX_ARTIFACT_URI_CHARACTERS`, `MAX_ARTIFACT_PAYLOAD_CHARACTERS`, `MAX_LOCATOR_AGGREGATE_CHARACTERS`, `MAX_TURN_ARTIFACT_CHARACTERS`, `MAX_RELAY_ARTIFACTS_TOTAL`=8, `MAX_BASE64_PADDING`=2, `DEFAULT_MEDIA_TYPE`='application/octet-stream') | n/chars | prefijo juzgado, URIs entregables, padding base64 | fijo | — |
| `PROTOCOL_VERSION` (`schemas/core.ts:6`) | — | `'3.0'` | fijo | e2e |
| Estados delivery (8), ACK (4), lanes (2), permisos (4) | enum | — | fijo | e2e |
| Destinatarios 0–100, `delivery_ids` 1–100, prioridad ±100 (techo agente 50, suelo humano 60) | n | — | fijo | e2e |
| `MAX_MESSAGE_TIMEOUT_MS` (`messages.ts:57`) | ms | 604_800_000 (7 días) | fijo | — |
| `MAX_NOTIFY_BODY_BYTES` (`:190`) | bytes UTF-8 | 4_096 | fijo | — |
| Patrones: alias `^[a-z]…{0,63}$`, tenant, UUID, hash sha256 | regex | — | fijo | e2e |

## 11. DB, pool, jobs y outbox

| Parámetro | Unidad | Valor | Fuente | Cubre |
|---|---|---|---|---|
| Pool pg (`db.ts:73`) | conns/ms | máx 20, timeout 5_000 | fijo (caller pisa) | — |
| `subscribeDeliveryWakes` backoff (`db.ts:312`) | ms | 100 → 5_000 exp | fijo | — |
| `claimJobs` / `claimFairJobs` (`jobs.ts:31`) | filas/ms | 1 / 30_000 (+burst 3) | fijo | — |
| `claimOutbox` / `claimWakeOutbox` (`outbox/claims.ts:64`) | filas/ms | 50 / 30_000 | fijo | — |
| Listados (jobs, relays, DLQ, audit, mensajes) | filas | 100–500 según endpoint | fijo | — |
| `max_attempts` (deliveries/outbox/jobs) | intentos | default en DB | DB (src solo lee) | e2e (DLQ) |

## 12. Stack de pruebas (solo test, `ops/compose.test.yaml`)

| Parámetro | Valor | Cubre |
|---|---|---|
| `CAUCE_DEV_AUTH=1`, `CAUCE_ACK_DEADLINE_MS=50`, `DISPATCHER_POLL_MS=20`, `ACK_TIMEOUT_MS=50` | overrides de timing | e2e |
| `CAUCE_RETRY_TIMEOUT_MS=45000`, `CAUCE_PRESENCE_LEASE_MS=500`, `CAUCE_FAULT_MODE=none` | overrides de arnés | e2e |
| `CAUCE_TEST_DATABASE_URL` | URL opcional de una base externa cuyo nombre empieza por `cauce_test`; nunca productiva. Las fixtures OAuth la rechazan y aprovisionan sus propios contenedores desechables | preflight `test:core`, fixtures de PostgreSQL |
| Puerto `127.0.0.1:18080`, postgres tmpfs, red interna | aislamiento | — |

## Decisiones del dueño (FR-011..FR-015, cerradas 2026-09-27)

| # | Decisión | Efecto |
|---|---|---|
| FR-011 | Solo techo nativo 4 MiB para claude/hermes, sin número inventado | §1 sin topes |
| FR-012 | Retención TUI 30 días + poda automática | implementar sweeper (T014a) |
| FR-013 | NO podar `secret.granted` ni auditoría | aceptado sin tope |
| FR-014 | Aceptar recarga por el propio alias con su certificado | verificar + test (T021) |
| FR-015 | Medir latencias en la pila antes de fijar SLO | medición (T014b) |
