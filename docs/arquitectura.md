# Arquitectura de Cauce V3

## 1. Qué es

Bus de mensajería durable entre agentes de IA en CLI (Claude Code, Codex, OpenClaw) de uno o varios tenants, con consola web de operador y puente Telegram (`AGENTS.md`). PostgreSQL es la única fuente durable; el gateway expone HTTP/WS; la entrega es *pull*: el adapter de cada agente reclama sus entregas por WebSocket con fencing (`claim_token`+`epoch`) (`AGENTS.md`). El `dispatcher` no reparte nada — es el segador de reintentos (`services/dispatcher/README.md`). "Entregar" significa pegar el texto en la sesión tmux viva del CLI del agente (`packages/adapter-sdk/README.md`). El bundle versionado de migraciones alcanza el esquema 041; el esquema vivo de una instalación se acredita con `schema_migrations` y las sondas de operación, no se infiere desde este documento.

Documentación detallada por pieza: [consola.md](consola.md), [telegram.md](telegram.md), [adapter-sdk.md](adapter-sdk.md), [calidad-y-gates.md](calidad-y-gates.md). El [mapa navegable con Archify](diagramas/README.md) muestra la topología del repo y sus fuentes verificables.

## 2. Mapa de piezas

### 2.1 Servicios (`deploy/compose.yaml`, stack `${COMPOSE_PROJECT_NAME:-cauce-v3-prod}`)

| Servicio | Función | Puerto publicado | Puertos internos |
|---|---|---|---|
| `gateway` | único punto de entrada HTTP+WS; identidad, ACLs, ACK, fachadas de consola, plano de control de terminal | `8443` (TLS) (`deploy/compose.yaml:200`) | health `8081` (`deploy/compose.yaml:73`) |
| `dispatcher` | segador: reintenta entregas rancias, poda observabilidad; único handler de negocio es `system.database.probe` (`services/dispatcher/README.md`) | — | `8082` (`deploy/compose.yaml:333`) |
| `terminal-relay` | puente TLS-mutuo navegador↔pty-agent; pierna agente `8445`, pierna navegador `8446` interna, health `8085`; perfil `terminal`, réplica única (`deploy/compose.yaml:212-233`) | `8445` (`deploy/compose.yaml:313`) | `8446`, `8085` |
| `telegram-bridge` | polling/egress de Telegram, cursor y lease cercados; perfil `telegram` (`deploy/compose.yaml:393-395`) | — | `8086` (`deploy/compose.yaml:402`) |
| `console` | SPA React servida por nginx-unprivileged, TLS propio, mTLS hacia el gateway | `8444` (`deploy/compose.yaml:454`) | `8444` |
| `migrator` | corre `deploy/migrate.mjs` una vez, `restart: "no"` (`deploy/compose.yaml:31-34`) | — | — |
| `outbox-metrics` | expone métricas del outbox y del estado de release para Prometheus (`deploy/compose.yaml:353-365`) | — | `8084` |
| `postgres` | única fuente durable (`deploy/compose.postgres.yaml`, compuesto aparte por `deploy/deploy.sh:15`) | — | `5432` |
| `prometheus` | scrape de gateway/dispatcher/outbox-metrics; perfil `observability` (`deploy/compose.yaml:517-533`) | — | `9090` |
| `otel-collector` | recolector OTel; perfil `observability` (`deploy/compose.yaml:497-515`) | — | `4317-4318` |

Todos los servicios de runtime comparten una sola imagen (`CAUCE_RUNTIME_IMAGE`, target `runtime` del Dockerfile) y arrancan por `deploy/runtime-entrypoint.sh` con `user 1000:1000`, `read_only: true`, `cap_drop: ALL` (`deploy/compose.yaml:1-16`).

### 2.2 Paquetes

| Paquete | Exporta | Fuente |
|---|---|---|
| `packages/protocol` | schemas Zod del wire `3.0`: `PublishMessage` estricto sin identidad, escalera de ACK `accepted→started→done|failed`, prioridad, perfiles de agente | `packages/protocol/src/index.ts`, `schemas.ts`, `agent-profile.ts`, `publish-receipt.ts` (`packages/protocol/README.md`) |
| `packages/store` | `CauceRepository`: mensajes, entregas con fencing claim/epoch, outbox, DLQ, jobs, config versionada, agentes, auditoría; migrator transaccional 001→041 con huecos deliberados (022/025/029/036) | `packages/store/src/repository.ts` (fachada) + `repository/{messages,outbox,jobs,config,observability,quotas,deliveries,agents}/**`; `migrations/` (`packages/store/README.md`) |
| `packages/adapter-sdk` | motor del consumidor durable (WS de larga vida, ACK correlacionado por `event_id`+`delivery_id`+`attempt`+`claim_token`) y ejecución sobre el harness (pegar en tmux) | `src/sdk/engine.ts`, `src/shared-session/{paste-runner,tmux}.ts`, ejecutables reales `src/bin/{claude,codex,openclaw}.ts` (`packages/adapter-sdk/README.md`) |
| `packages/mcp-fleet-monitor` | servidor MCP de solo lectura: `fleet_status`, `deliveries`, `chain`, `dead_letters`, `health` (`packages/mcp-fleet-monitor/src/tool-server.ts:16-71`) | `packages/mcp-fleet-monitor/README.md` |

### 2.3 El adaptador dentro del contenedor: supervisor → runtime → harness

- **Supervisor**: `ops/scripts/container-adapter-supervisor.sh`, invocado por la unit systemd del alias; resuelve config/bundle/PKI por root o rootless, valida el bind del contenedor y ejecuta con lock (`ops/scripts/container-adapter-supervisor.sh:5-33`).
- **Runtime**: `ops/container-runtime/cauce-container-runtime.py`, corre dentro del contenedor; gestiona generación/PID de metadatos y falla cerrado si el PID de la generación vigente no existe (`ops/container-runtime/cauce-container-runtime.py:1084`).
- **Harness**: `packages/adapter-sdk/src/bin/{claude,codex,openclaw}.ts` → `runCli()` monta `DurableStore` + `HarnessAdapter` sobre el runner correspondiente (spawn o API de OpenClaw) (`packages/adapter-sdk/src/bin/shared.ts:197-233`).

### 2.4 El plano PTY: launcher → agente → relay

- **Launcher**: `ops/pty-agent/cauce-pty-launcher.sh` hace `docker cp` del **paquete** a `/var/tmp/cauce-pty-agent-<alias>/` y lo ejecuta con `docker exec ... python3 -m cauce_pty_agent`, supervisado por unidades user `cauce-v3-pty@<alias>` (`ops/pty-agent/README.md`).
- **Agente**: `ops/pty-agent/cauce_pty_agent/`, paquete Python stdlib con un módulo por responsabilidad (`ops/pty-agent/README.md`), corre dentro del contenedor de cada alias y marca SALIENTE por TLS mutuo hacia el relay — nunca escucha puerto; abre PTYs (`shell`/`harness`) y sirve lectura/escritura de ficheros de gobierno (tags 0x50-0x5E, CAS+rollback).
- **Relay**: `services/terminal-relay` — pierna agente (`8445`, TLS mutuo por fingerprint, un HELLO nuevo expulsa al anterior) y pierna navegador (`8446`, interna) (`services/terminal-relay/README.md`).

## 3. Flujo de un mensaje

**Ingreso** — Telegram entra por `telegram-bridge`, que persiste mediante `CauceRepository` sobre PostgreSQL; la consola web y el CLI de operador publican por el gateway autenticado.

**Gateway** — `services/gateway/src/app.ts` compone `routes/{health,console,core,console-publish,chain-gates}` y el plugin de terminal. `routes/core.ts` (628 líneas) + `routes/core/{contracts,helpers,http,outbox,publish}.ts` implementan `POST /v3/messages` (publicar, identidad derivada del principal autenticado — el payload público es `strict`), `POST /v3/connections/hello`, `/v3/heartbeat`, `/v3/ack`, y `GET /v3/ws` (`services/gateway/src/routes/core.ts:332`) — el socket de larga vida de cada adapter.

**Deliveries → claim por adaptador** — `packages/store/src/repository/deliveries/claims.ts:24` (`acquireLease`) concede el lease con `claim_token`+`epoch`; el adapter lo confirma con `packages/store/src/repository/deliveries/acks.ts:54` (`DeliveryAcksRepository`).

**Harness** — `packages/adapter-sdk/src/sdk/engine.ts` corre el bucle claim→ACK→pegar texto; `shared-session/paste-runner.ts` + `tmux.ts` hacen el pegado real con marcadores de bloque.

**ACK** — escalera monotónica `accepted → started → done|failed`; un `event_id` repetido nunca reaplica una transición (`packages/protocol/README.md`).

**Fan-in** — `packages/store/src/repository/agents/fanin.ts:14` (`AgentFaninRepository`) materializa las respuestas de una delegación A→B→C antes de devolverlas al origen.

**Fencing** — tres mecanismos independientes: (a) `epoch` creciente por `(tenant, alias)` en las entregas normales (un consumer viejo pierde su claim); (b) `claim_token` de terminal, migraciones `032_terminal_session_claim_fencing.sql`, `033_terminal_browser_owner_fencing.sql`; (c) `034_terminal_relay_instance_fencing.sql` — el relay solo arranca si `CAUCE_TERMINAL_RELAY_INSTANCE_ID` coincide con el sha256 del DER de su propio certificado cliente hacia el gateway (`deploy/compose.yaml:95`, `deploy/deploy.sh:93-94`).

## 4. La flota como datos

La BD (`agents` + `memberships`) es la única verdad; todo lo demás se deriva (`ops/runbooks/alta-y-baja-de-agente.md`). Cadena de generación:

```
BD (agents + memberships)
  → ops/scripts/export-fleet-snapshot.py  (consulta ops/scripts/fleet-query.sql, funde el overlay físico)
  → ops/flota.json                        (snapshot canónico, schemaVersion 1, sin timestamps ni comentarios)
  → ops/scripts/regenerate-fleet.sh       (encadena los seis generadores)
  → ops/container-aliases.json · ops/manifests/*.yaml · units systemd · ops/telegram-runtime/config.json
```

Los generadores son `generate-container-aliases.py`, `generate-manifests.py`, `generate-runtime-fleet.py`, `generate-units.py`, `generate-container-units.py` y `generate-telegram-config.py`, encadenados en ese orden por `ops/scripts/regenerate-fleet.sh:11-43` (primero contra un tmpdir de preflight, luego sobre el árbol). Las fórmulas puras (`env_name`, reglas por harness) viven en una sola casa, `ops/scripts/fleet_derive.py`.

El snapshot no tiene un tamaño fijo: lleva **una entrada por alias que la BD declare habilitado**, y cada entrada define `tenant`, `room`, `role`, `harness`, `enabled`, `container`, `user`, `home` y `runtimeStateDirectory` (los campos que el exportador exige en `AGENT_FIELDS`/`MEMBERSHIP_FIELDS`, `ops/scripts/export-fleet-snapshot.py:30-50`). Junto a `fleet` escribe `systemPrincipals`, `retired` y `placement` (`ops/scripts/export-fleet-snapshot.py:297-303`). `enabled` tiene una sola fuente (`agents.enabled`): deshabilitado va a `retired`, no a bookkeeping manual.

El único fichero editado a mano de toda la cadena es el overlay físico `ops/flota-fisica.json` (`schemaVersion` + `placement`, y nada más: cualquier otra clave se rechaza al leerlo, `ops/scripts/export-fleet-snapshot.py:158-164`). El exportador lo funde en `placement` del snapshot y lo valida contra la flota: sólo admite las claves `dockerHost`, `registryContainer` y `healthContainer` (`PLACEMENT_KEYS`, `:26`), sólo admite en `dockerHost` los hosts que declara `DOCKER_HOSTS` (`:27`), rechaza el overlay si nombra un alias que no está en la flota (`:292-294`) y rechaza una entrada vacía o que repita el valor por defecto, para que el overlay no acumule filas redundantes (`:133-147`).

**Gates G-SNAP**: `ops/scripts/validate.sh` regenera `container-aliases.json` y `manifests/` desde `ops/flota.json` en un tmpdir y exige identidad byte a byte con lo commiteado — es el gate contra edición manual de generados (`ops/scripts/validate.sh:21-55`).

**Alta/baja**: `ops/cli/cauce <alias> aprovisionar` y `... retirar`, subcomandos del dispatcher principal del CLI (`ops/cli/cauce:1439-1440`). `aprovisionar` no escribe en la BD — imprime el SQL para que lo corra el dueño — y encadena las piezas de credenciales: ubicación de `ca.key` documentada a mano; `agent-<alias>.{crt,key}` vía `provision-agent-identity.sh`; bearer token + hash publicados con CAS; `alias-key.hex` de PTY vía `publish-alias-key.sh`; certificado y huella del plano PTY; `container-pki/<alias>/` + `<alias>.env`; y la config de Telegram con el token de BotFather pegado a mano y verificado (`ops/runbooks/alta-y-baja-de-agente.md`). `retirar` primero deshabilita en BD (el gateway deja de autorizar en vivo) y después revoca credenciales.

## 5. Despliegue

Fuente única: el compose del propio repo, sin overrides externos — `deploy/deploy.sh` compone `deploy/compose.yaml` + `deploy/compose.postgres.yaml` desde `$REPO/deploy` (`deploy/deploy.sh:15`). Exige HEAD limpio e idéntico a `origin/main`, root, y `CAUCE_FASE3_CON_DUENO=si` (`deploy/deploy.sh:34-58`). Secuencia: build de las dos imágenes del `deploy/Dockerfile` (targets `runtime` — gateway/dispatcher/terminal-relay/telegram-bridge/migrator/outbox-metrics comparten una imagen — y `console`, con el instance-id del relay horneado en el nginx de consola) → push al registry configurado (`CAUCE_DEPLOY_REGISTRY`, por defecto `127.0.0.1:5000`) → pin por digest en `prod.env` → verificación de que no hay sesiones de terminal fantasma → `migrator` en transacción única → `up -d --wait` → `deploy/refresh-observability.sh` → `deploy/smoke.sh` → fila en `deploy/HISTORIAL.md` (`deploy/deploy.sh:99-138`). Las migraciones llevan guard: la imagen aplana `deploy/runtime/migrate.mjs` a `deploy/migrate.mjs` (`deploy/Dockerfile:93`) y el migrator rechaza correr fuera de ese camino. Un fallo de migración hace rollback total automático en la BD; un smoke rojo dice restaurar el `.pre-deploy-<stamp>` de `prod.env` y repetir `up`.

## 6. Gates de calidad

`pnpm typecheck` (core+adapter+mcp+console, `package.json:45`) y `pnpm lint` (`package.json:24`: ESLint por zona, gate AST con baseline cero de ciclos runtime, `lint:estricto:zonas` con reglas más duras, `ruff check` sobre Python, `scripts/calidad.mjs` con trinquete de líneas por fichero y de fechas en comentarios) son gate de todo commit (`AGENTS.md`). `pnpm test:unit` (`package.json:47`) corre los paquetes con test propio más `tests/unit` y `packages/protocol/test`; `pnpm test` (`scripts/test-all.mjs`) recorre las once suites de `SUITES` (`scripts/test-all.mjs:8-20`), incluidas las pruebas directas de `ops/tests` que descubre `ops/tests/run-all.mjs`. `ops/scripts/validate.sh` valida sintaxis de todos los `.sh`/`.mjs` de `ops`+`deploy`, exige ShellCheck, valida YAML/JSON Schema y comprueba la identidad byte a byte de generados (§4). La especificación visual se valida con `pnpm arch:validate` y se inspecciona en varios tamaños con `pnpm arch:visual-check`.

## 7. Topología física

Cauce no impone una topología: la declara y la deriva. El stack del compose corre en **un** host — el que publica los puertos, monta los ficheros de observabilidad y guarda el volumen de PostgreSQL. Los contenedores de los alias son otra cosa: cada alias vive en el contenedor que su fila de BD declara (`container` en el snapshot), y varios alias del mismo tenant pueden compartir contenedor, con la consecuencia de seguridad que eso tiene — una shell dentro de un contenedor ve los directorios de todos los alias que lo comparten, y por eso las compuertas de terminal razonan sobre la **cohorte** del contenedor, no sobre un alias (ver [threat-model.md](threat-model.md)).

Por defecto ese contenedor está en el mismo host del stack. El overlay `placement` es lo único que rompe ese supuesto: permite apuntar un alias a otro demonio Docker (`dockerHost`, restringido a los hosts de `DOCKER_HOSTS`), y separar el contenedor que se sondea para salud (`healthContainer`) del que se consulta en el registro de presencia (`registryContainer`). Un alias sin entrada en `placement` no necesita ninguna: los tres valores tienen defecto derivado y el exportador rechaza la entrada que los repita (`ops/scripts/export-fleet-snapshot.py:133-147`).
