# Arquitectura de Cauce V3

## 1. Qué es

Bus de mensajería durable entre agentes de IA en CLI (Claude Code, Codex, OpenClaw) de 4 tenants, con consola web de operador y puente Telegram (`AGENTS.md:3`). PostgreSQL es la única fuente durable; el gateway expone HTTP/WS; la entrega es *pull*: el adapter de cada agente reclama sus entregas por WebSocket con fencing (`claim_token`+`epoch`) (`AGENTS.md:3`). El `dispatcher` no reparte nada — es el segador de reintentos (`services/dispatcher/README.md:3`). "Entregar" significa pegar el texto en la sesión tmux viva del CLI del agente (`packages/adapter-sdk/README.md:5`). El bundle versionado de migraciones alcanza el esquema 038; el estado vivo de producción se acredita con las sondas de operación, no se infiere desde este documento.

Documentación detallada por pieza: [consola.md](consola.md), [telegram.md](telegram.md), [adapter-sdk.md](adapter-sdk.md), [calidad-y-gates.md](calidad-y-gates.md). El [mapa navegable con Archify](diagramas/README.md) muestra la topología actual y sus fuentes verificables.

## 2. Mapa de piezas

### 2.1 Servicios (`deploy/compose.yaml`, stack `cauce-v3-prod`)

| Servicio | Función | Puerto publicado | Puertos internos |
|---|---|---|---|
| `gateway` | único punto de entrada HTTP+WS; identidad, ACLs, ACK, fachadas de consola, plano de control de terminal | `8443` (TLS) (`deploy/compose.yaml:196-197`) | health `8081` (`deploy/compose.yaml:73`) |
| `dispatcher` | segador: reintenta entregas rancias, poda observabilidad; único handler de negocio es `system.database.probe` (`services/dispatcher/README.md:3`) | — | `8082` (`deploy/compose.yaml:325`) |
| `terminal-relay` | puente TLS-mutuo navegador↔pty-agent; pierna agente `8445`, pierna navegador `8446` interna, health `8085`; perfil `terminal`, réplica única (`deploy/compose.yaml:209-230`) | `8445` (`deploy/compose.yaml:301-305`) | `8446`, `8085` |
| `telegram-bridge` | polling/egress de Telegram, cursor y lease cercados; perfil `telegram` (`deploy/compose.yaml:385-387`) | — | `8086` (`deploy/compose.yaml:394`) |
| `console` | SPA React servida por nginx-unprivileged, TLS propio, mTLS hacia el gateway | `8444` (`deploy/compose.yaml:445-446`) | `8444` |
| `migrator` | corre `deploy/migrate.mjs` una vez, `restart: "no"` (`deploy/compose.yaml:31-34`) | — | — |
| `outbox-metrics` | expone métricas del outbox y del estado de release para Prometheus (`deploy/compose.yaml:345-347`) | — | `8084` |
| `postgres` | única fuente durable (`deploy/compose.postgres.yaml`, compuesto aparte por `deploy.sh:10`) | — | `5432` |
| `prometheus` | scrape de gateway/dispatcher/outbox-metrics; perfil `observability` (`deploy/compose.yaml:509-534`) | — | `9090` |
| `otel-collector` | recolector OTel; perfil `observability` (`deploy/compose.yaml:489-507`) | — | `4317-4318` |

Todos los servicios de runtime comparten una sola imagen (`CAUCE_RUNTIME_IMAGE`, target `runtime` del Dockerfile) y arrancan por `deploy/runtime-entrypoint.sh` con `user 1000:1000`, `read_only: true`, `cap_drop: ALL` (`deploy/compose.yaml:1-16`).

### 2.2 Paquetes

| Paquete | Exporta | Fuente |
|---|---|---|
| `packages/protocol` | schemas Zod del wire `3.0`: `PublishMessage` estricto sin identidad, escalera de ACK `accepted→started→done|failed`, prioridad, perfiles de agente | `packages/protocol/src/index.ts`, `schemas.ts`, `agent-profile.ts`, `publish-receipt.ts` (`packages/protocol/README.md:3-6`) |
| `packages/store` | `CauceRepository`: mensajes, entregas con fencing claim/epoch, outbox, DLQ, jobs, config versionada, agentes, auditoría; migrator transaccional 001→038 con huecos deliberados (022/025/029/036) | `packages/store/src/repository.ts` (fachada, 43 líneas) + `repository/{messages,outbox,jobs,config,observability,quotas,deliveries,agents}/**`; `migrations/` (`packages/store/README.md:5`) |
| `packages/adapter-sdk` | motor del consumidor durable (WS de larga vida, ACK correlacionado por `event_id`+`delivery_id`+`attempt`+`claim_token`) y ejecución sobre el harness (pegar en tmux) | `src/sdk/engine.ts`, `src/shared-session/{paste-runner,tmux}.ts`, ejecutables reales `src/bin/{claude,codex,openclaw}.ts` (`packages/adapter-sdk/README.md:3-9`) |
| `packages/mcp-fleet-monitor` | servidor MCP de solo lectura: `estado_flota`, `entregas`, `cadena`, `dead_letters`, `salud` — escrito y probado, sin registrar en ningún alias hoy | `packages/mcp-fleet-monitor/README.md:3-5` |

### 2.3 El adaptador dentro del contenedor: supervisor → runtime → harness

- **Supervisor**: `ops/scripts/container-adapter-supervisor.sh`, invocado por la unit systemd del alias; resuelve config/bundle/PKI por root o rootless, valida el bind del contenedor y ejecuta con lock (`ops/scripts/container-adapter-supervisor.sh:1-33`).
- **Runtime**: `ops/container-runtime/cauce-container-runtime.py`, corre dentro del contenedor; gestiona generación/PID de metadatos y falla cerrado si el PID de la generación vigente no existe (`ops/container-runtime/cauce-container-runtime.py:1086`).
- **Harness**: `packages/adapter-sdk/src/bin/{claude,codex,openclaw}.ts` → `runCli()` monta `DurableStore` + `HarnessAdapter` sobre el runner correspondiente (spawn o API de OpenClaw) (`packages/adapter-sdk/src/bin/shared.ts:173-203`).

### 2.4 El plano PTY: launcher → agente → relay

- **Launcher**: `ops/pty-agent/cauce-pty-launcher.sh` hace `docker cp` del agente Python al contenedor y lo ejecuta con `docker exec`, supervisado por unidades user `cauce-v3-pty@<alias>` (`ops/pty-agent/README.md:9`).
- **Agente**: `ops/pty-agent/cauce_pty_agent.py`, un solo fichero Python stdlib, corre dentro del contenedor de cada alias y marca SALIENTE por TLS mutuo hacia el relay — nunca escucha puerto; abre PTYs (`shell`/`harness`) y sirve lectura/escritura de ficheros de gobierno (tags 0x50-0x5E, CAS+rollback) (`ops/pty-agent/README.md:3-7`).
- **Relay**: `services/terminal-relay` — pierna agente (`8445`, TLS mutuo por fingerprint, un HELLO nuevo expulsa al anterior) y pierna navegador (`8446`, interna) (`services/terminal-relay/README.md:3-5`).

## 3. Flujo de un mensaje

**Ingreso** — Telegram entra por `telegram-bridge`, que persiste mediante `CauceRepository` sobre PostgreSQL; la consola web y el CLI de operador publican por el gateway autenticado.

**Gateway** — `services/gateway/src/app.ts` compone `routes/{health,console,core,console-publish,chain-gates}` y el plugin de terminal. `routes/core.ts` (628) + `routes/core/{contracts,helpers,http,outbox,publish}.ts` implementan `POST /v3/messages` (publicar, identidad derivada del principal autenticado — el payload público es `strict`), `POST /v3/connections/hello`, `/v3/heartbeat`, `/v3/ack`, y `GET /v3/ws` (`services/gateway/src/routes/core.ts:207`) — el socket de larga vida de cada adapter.

**Deliveries → claim por adaptador** — `packages/store/src/repository/deliveries/claims.ts:22` (`acquireLease`) concede el lease con `claim_token`+`epoch`; el adapter lo confirma con `packages/store/src/repository/deliveries/acks.ts:36` (`DeliveryAcksRepository`).

**Harness** — `packages/adapter-sdk/src/sdk/engine.ts` corre el bucle claim→ACK→pegar texto; `shared-session/paste-runner.ts` + `tmux.ts` hacen el pegado real con marcadores de bloque.

**ACK** — escalera monotónica `accepted → started → done|failed`; un `event_id` repetido nunca reaplica una transición (`packages/protocol/README.md:5`).

**Fan-in** — `packages/store/src/repository/agents/fanin.ts:14` (`AgentFaninRepository`) materializa las respuestas de una delegación A→B→C antes de devolverlas al origen.

**Fencing** — tres mecanismos independientes: (a) `epoch` creciente por `(tenant, alias)` en las entregas normales (un consumer viejo pierde su claim); (b) `claim_token` de terminal, migraciones `032_terminal_session_claim_fencing.sql`, `033_terminal_browser_owner_fencing.sql`; (c) `034_terminal_relay_instance_fencing.sql` — el relay solo arranca si `CAUCE_TERMINAL_RELAY_INSTANCE_ID` coincide con el sha256 del DER de su propio certificado cliente hacia el gateway (`deploy/compose.yaml:95`, `deploy/deploy.sh:40-46`).

## 4. La flota como datos

La BD (`agents` + `memberships`) es la única verdad; todo lo demás se deriva (`ops/runbooks/alta-y-baja-de-agente.md`). Cadena de generación: `ops/scripts/export-fleet-snapshot.py` lee `agents`/`memberships` con `fleet-query.sql` y escribe canónico `ops/flota.json` (`schemaVersion: 1`, sin timestamps ni comentarios) → `ops/scripts/generate-container-aliases.py`, `generate-manifests.py`, `generate-runtime-fleet.py`, `generate-units.py`, `generate-container-units.py`, `generate-telegram-config.py`, encadenados por `ops/scripts/regenerate-fleet.sh:11-43`, producen `ops/container-aliases.json`, `ops/manifests/*.yaml`, las units systemd y `ops/telegram-runtime/config.json`. Las fórmulas puras (`env_name`, reglas por harness) viven en una sola casa, `ops/scripts/fleet_derive.py`.

`ops/flota.json` (14 entradas hoy) define por alias: `tenant`, `room`, `role`, `harness`, `enabled`, `container`, `user`, `home`, `runtimeStateDirectory` (`ops/flota.json:2-157`). `enabled` tiene una sola fuente (`agents.enabled`): deshabilitado va a `retired`, no a bookkeeping manual (`ops/flota.json:167`). El único fichero editado a mano es el overlay físico `ops/flota-fisica.json`, que el exportador funde en `placement` — hoy `kant` (health en `ctrl-infra`, registro en `host:kratos`) y `salva` (`dockerHost: kratos`) (`ops/flota-fisica.json:2-9`).

**Gates G-SNAP**: `ops/scripts/validate.sh` regenera `container-aliases.json` y `manifests/` desde `ops/flota.json` en un tmpdir y exige identidad byte a byte con lo commiteado — es el gate contra edición manual de generados (`ops/scripts/validate.sh:5-33`).

**Alta/baja**: `ops/cli/cauce <alias> aprovisionar` y `... retirar`, subcomandos del dispatcher principal del CLI (`ops/cli/cauce:1433-1442`). `aprovisionar` no escribe en la BD — imprime el SQL para que lo corra el dueño — y encadena las 6 piezas de credenciales: (0) ubicación de `ca.key` documentada a mano; (1) `agent-<alias>.{crt,key}` vía `provision-agent-identity.sh`; (2) bearer token + hash publicados con CAS; (3) `alias-key.hex` de PTY vía `publish-alias-key.sh`; (4) `container-pki/<alias>/` + `<alias>.env`; (5) config de Telegram con el token de BotFather pegado a mano y verificado (`ops/runbooks/alta-y-baja-de-agente.md`). `retirar` primero deshabilita en BD (el gateway deja de autorizar en vivo) y después revoca credenciales.

## 5. Despliegue

Fuente única: el compose del propio repo, sin overrides externos — `deploy/deploy.sh` compone `deploy/compose.yaml` + `deploy/compose.postgres.yaml` desde `$REPO/deploy` (`deploy/deploy.sh:10`). Exige HEAD limpio e idéntico a `origin/main`, root, y `CAUCE_FASE3_CON_DUENO=si` (`deploy/deploy.sh:19-24`). Secuencia: build de las dos imágenes del `deploy/Dockerfile` (targets `runtime` — gateway/dispatcher/terminal-relay/telegram-bridge/migrator/outbox-metrics comparten una imagen — y `console`, con el instance-id del relay horneado en el nginx de consola) → push al registry local `127.0.0.1:5000` → pin por digest en `prod.env` → verificación de que no hay sesiones de terminal fantasma → `migrator` en transacción única → `up -d --wait` → `deploy/smoke.sh` → fila en `deploy/HISTORIAL.md` (`deploy/deploy.sh:47-76`). Las migraciones llevan guard: la imagen aplana `deploy/runtime/migrate.mjs` a `deploy/migrate.mjs` (`deploy/Dockerfile:93`) y el migrator rechaza correr fuera de ese camino. Un fallo de migración hace rollback total automático; un smoke rojo dice restaurar el `.pre-deploy-<stamp>` de `prod.env` y repetir `up`.

## 6. Gates de calidad

`pnpm typecheck` (core+adapter+mcp+console) y `pnpm lint` (ESLint por zona, gate AST con baseline cero de ciclos runtime, `lint:estricto:zonas` con reglas más duras sobre console/terminal-relay/telegram-bridge/dispatcher/tests, `ruff check` sobre Python, `scripts/calidad.mjs` con trinquete de líneas por fichero y de fechas en comentarios) son gate de todo commit (`package.json:17-28`, `AGENTS.md`). `pnpm test:unit` corre los paquetes con test propio más `tests/unit` y `packages/protocol/test`; `pnpm test` (`scripts/test-all.mjs`) recorre las nueve suites, incluidas las 31 pruebas directas de `ops/tests`. `ops/scripts/validate.sh` valida sintaxis de todos los `.sh`/`.mjs` de `ops`+`deploy`, exige ShellCheck, valida YAML/JSON Schema y comprueba la identidad byte a byte de generados (§4). La especificación visual se valida con `pnpm arch:validate` y se inspecciona en varios tamaños con `pnpm arch:visual-check`.

## 7. Máquinas

| Máquina | Papel | Qué corre |
|---|---|---|
| VPS (esta, Ryzen 9700X) | centro de mando: repo, bus, producción | los 10 contenedores `cauce-v3-prod-*`; todos los alias de la flota menos `kant` y `salva`, uno por contenedor de tenant (`docs/flota-y-participantes.md:8`) |
| Torre `kratos` (9950X3D) | desarrollo del dueño | los alias `kant` y `salva` (`ops/flota-fisica.json:2-9`); contenedores de prueba y respaldo |

Cada alias vive en su propio contenedor (`agv2-<tenant>-<alias>-oc`, `ws-<alias>`, `claw`, `claw-<tenant>`…), listados uno a uno en `ops/flota.json:2-157`; varios alias de un mismo tenant pueden compartir contenedor (p. ej. `atlas` y `kratos` en `ws-humanizar`).
