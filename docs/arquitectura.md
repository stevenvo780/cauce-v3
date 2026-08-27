# Cómo leer Cauce V3 (guía para humanos)

Este repo lo escribieron IAs y se está reestructurando. Esta guía existe para que una persona pueda navegarlo sin perderse: te dice **en qué orden leer los archivos** de cada flujo, qué ignorar, y dónde vive lo operativo. Si solo lees un documento, que sea este.

## El sistema en 30 segundos

```
  Telegram ──▶ telegram-bridge ──┐
  Consola web (React) ───────────┼──▶ GATEWAY (HTTP/WS) ◀──▶ PostgreSQL (única verdad)
                                  │        ▲
  adapter de cada agente ────────┘        │ pull por WebSocket (el agente RECLAMA sus entregas)
       │
       └──▶ pega el mensaje en la sesión tmux del CLI (claude / codex / openclaw)

  Terminal en vivo (aparte del bus):
  navegador ──▶ nginx de la consola ──▶ terminal-relay ◀── pty-agent (Python, DENTRO del
                                        (TLS mutuo)         contenedor de cada agente)
```

Tres ideas que lo explican casi todo:
1. **Nada existe hasta que está en PostgreSQL.** Los WebSockets solo aceleran.
2. **Nadie empuja mensajes a los agentes.** Cada adapter reclama sus entregas (claim con token+epoch) y confirma con la escalera `accepted → started → done|failed`. El `dispatcher`, pese al nombre, no reparte: es el segador de reintentos.
3. **"Entregar" = pegar texto en la tmux del CLI** y esperar el turno del modelo. Ahí está la fragilidad real (timeouts), no en el bus.

El gateway ya no es un monolito: `services/gateway/src/app.ts` (~400 líneas) solo compone cinco `routes/*` y un plugin de terminal; las rutas viven en `services/gateway/src/routes/{console,core,health,console-publish,chain-gates-legado}.ts` y los helpers específicos de consola en `services/gateway/src/console/*.ts`.

## Flujo 1 — Un mensaje de A a B (orden de lectura)

| # | Archivo | Qué buscar |
|---|---|---|
| 1 | `packages/protocol/src/schemas.ts` | `PublishMessage`, la escalera de ACK, por qué el payload público NO lleva identidad |
| 2 | `services/gateway/src/app.ts` (~400) | el único `buildGateway()`: instala hooks (`console-security`, oidc/password) y monta `routes/{health,console,core,console-publish,chain-gates-legado}` + `terminal/plugin` |
| 3 | `services/gateway/src/routes/core.ts` (628) + `routes/core/{contracts,helpers,http,outbox,publish}.ts` (94+131+153+349+151 = 878) | `app.post('/v3/messages'` y `app.post('/v3/publish'` (publican), `app.post('/v3/connections/hello'`, `/v3/heartbeat`, `/v3/ack`, `/v3/deliveries/:id/ack` (sesión del adapter), `app.post('/v3/deliveries/query'` y `/v3/query` (consulta), `app.get('/v3/ws'` (el socket de los adapters) |
| 4 | `packages/store/src/repository.ts` (fachada, 43) + `repository/{messages,outbox,jobs,config,observability,quotas,deliveries,agents,agents/{fanin,chain-control,notifications}}.ts` (~14K líneas repartidas en 37 ficheros) | `publish`, el claim de deliveries con fencing, los ACK. La fachada hereda de los módulos y `new CauceRepository()` resuelve los métodos del original; SQL intacto en la mudanza (verificada en `el historial de git reportes/claude-revision-46-commits.md` §store-1/store-2) |
| 5 | `packages/adapter-sdk/src/sdk/engine.ts` (780) | el bucle del consumidor durable: claim → ACK → pegar texto |
| 6 | `packages/adapter-sdk/src/shared-session/paste-runner.ts` (8 barrel) + `paste-runner/{base,runner,persistence,runtime,harvest,contracts}.ts` (689+414+178+112+457+87 = 1.937) + `shared-session/tmux.ts` (57 barrel) + `tmux/{mutation,operations,identity}.ts` (642+569+327 = 1.538) | cómo se le pega el texto al CLI de verdad (tmux + marcadores de bloque) |
| 7 | `services/dispatcher/src/{index,handlers,config,metrics,main}.ts` (160+69+145+274+143 = 791) | el segador entero son 791 líneas (config + metrics + index + handlers + main); `handlers.ts` declara explícitamente "Agent/model execution is intentionally absent" |

## Flujo 2 — La TUI del agente en el navegador

| # | Archivo | Qué buscar |
|---|---|---|
| 1 | `console/src/features/terminal/pty-connection.ts` (orquestador: `pty-session.ts`, 308) | el cliente WS (xterm.js, reconexión, frames de control): `new WebSocket`, `openSocket`, `startViewerHeartbeat`, `stopHandshake/Reconnect` viven en `pty-connection.ts`; `pty-session.ts` los compone con `pty-input.ts`/`pty-output.ts`/`pty-theme.ts`/`pty-types.ts` |
| 2 | `console/nginx.conf` | el proxy `/v3/console/terminal/ws` → relay :8446 con mTLS |
| 3 | `services/gateway/src/terminal/plugin.ts` (326) + `services/gateway/src/terminal/session-control.ts` (785) + `services/gateway/src/terminal/relay-proxy.ts` (23 barrel + `relay-proxy/{close,consume,context,presence,resume}.ts` = 22) | el plano de control PTY: `registerTerminalControlPlane()` registra `/v3/console/terminal/{targets,sessions,sessions/:sid/owner,sessions/:sid}` (navegador) y `/v3/terminal/relay/{agents,sessions/:sid/{consume,resume,authz,close}}` (relay). El gateway DECIDE y AUDITA — no carga bytes de PTY |
| 4 | `services/terminal-relay/src/browser-leg.ts` + `agent-leg.ts` (206) | pierna navegador vs pierna agente: la primera canjea el ticket contra el gateway, la segunda abre TLS mutuo :8445 con identidad por fingerprint y aplica el `superseded` que expulsa conexiones duplicadas |
| 5 | `services/terminal-relay/src/sessions.ts` (248) + `gateway-client.ts` (498) | ciclo de vida de sesión + canje de tickets/authz/HTTP contra el gateway |
| 6 | `ops/pty-agent/cauce_pty_agent.py` (2661) | tabla de tags al inicio; `_serve` (HELLO), `_resolve_command` (tmux/openclaw TUI), `_spawn` (pty.fork); `TAG_READ` / `TAG_WRITE` (escritura con CAS y rollback). El módulo se complementa con `rollout_pty_lib.py` (736) |

## Flujo 3 — Editar CLAUDE.md / AGENTS.md / SOUL.md desde la web

| # | Archivo | Qué buscar |
|---|---|---|
| 1 | `console/src/features/live/FicherosTab.tsx` (+ `DirectivaModal.tsx`) | el editor: lee inventario, lee contenido, guarda con `expected_sha` |
| 2 | `console/src/api/client.ts` (840) | `GET|PUT …/documents/:kind/content` |
| 3 | `services/gateway/src/console/agent-documents.routes.ts` (610) + `services/gateway/src/console/agent-documents.ts` (40 barrel) + `agent-documents/{catalog,path-policy,relay-probe}.ts` (submódulos) | las 6 rutas (`/v3/console/{tenants/:tenantId/agents/:alias,agents/:alias}/documents[/:kind/content]`); `TerminalRelayFactsProbe` (read/write/list contra el relay). El módulo se importa en `routes/console.ts:7` y se monta dentro del phase 4 de `createConsoleRoutes` |
| 4 | `services/gateway/src/terminal/plugin.ts` → `governance-probes.ts` → `services/gateway/src/console/agent-directive.routes.ts` | el `GET /v3/console/agents/:tenant/:alias/directive` (DIRECTIVA de un alias) y los tags binarios 0x50–0x5E viajan por aquí; la sonda se instala en el hueco `app.sondaDeDocumentos` que `app.ts` dejó |
| 5 | `services/terminal-relay/src/governance-relay.ts` (598) + `framing.ts` (158) | las operaciones read/write y los tags binarios 0x50–0x5E |
| 6 | `ops/pty-agent/cauce_pty_agent.py` | los handlers `TAG_READ` / `TAG_WRITE` (escritura con CAS y rollback) |

**Estado:** la cadena está completa en el repo; en producción solo hay lectura parcial desplegada. Se estrena entera en FASE 3 (`plan-reestructura/31`).

## Qué IGNORAR al leer

- Los tests (≈45% del código) — léelos solo cuando toques esa pieza.
- `ops/` casi entero, salvo lo de la tabla siguiente.

## El mapa de `ops/` (la jungla, ordenada)

| Subdirectorio | Qué es | ¿Te importa? |
|---|---|---|
| `pty-agent/` | el agente de terminal (flujos 2 y 3) + su launcher y rollout | **Sí** |
| `systemd/` + `generated/` | plantillas de unidades y su salida generada (`pnpm ops:manifests`) | Cuando toques la flota |
| `manifests/` | un YAML de configuración por alias de agente | Cuando toques la flota |
| `guardias/` | espejos de los guardianes del host (los reales corren desde `/usr/local/sbin`) | FASE 3 (fichero 32) |
| `scripts/` | mitad utilidades vivas, mitad dudosos pendientes del dueño (`quota-collector`, `generate-telegram-config`, `update-alias-config`) | Poco |
| `harness/`, `tests/`, `schemas/` | QA con dobles de protocolo y sus contratos; las dos subcarpetas de tests (`tests/`, raíz del monorepo) cubren piezas vivas y cuarentena | Poco |
| `observability/`, `config/` | Prometheus/otel y configs | Cuando toques alertas |
| el resto (`cli/`, `patches/`, `security/`, `openclaw-gateway/`, `container-runtime/`, `console-login/`, `ai-live/`, `private/`) | piezas puntuales, autoexplicativas por su README o candidatas a limpieza | Rara vez |

## Dónde vive lo operativo (fuera del repo)

- **Contenedores**: `docker ps` → `cauce-v3-prod-{gateway,dispatcher,terminal-relay,telegram-bridge,console,postgres,prometheus,otel-collector,outbox-metrics}`. Hoy corren imágenes del 23–25 ago (anteriores a lo último de main).
- **Base de datos**: `docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce`. Aplicada hasta la migración 024; la 026–037 se aplican en FASE 3.
- **systemd**: timers `cauce-*` (backups, guardianes, revividor) y unidades de usuario `cauce-v3-pty@<alias>`.
- **Deploy actual (legacy, se reemplaza en FASE 3)**: `/opt/cauce-v3` + overrides en `/etc/cauce-v3/`.
- **Archivo de la purga de ramas** (27-08): `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle`.

## Tamaños honestos (para calibrar antes de bucear)

| Área | Fuente (no test) | Tests |
|---|---|---|
| gateway (`services/gateway/src`) | ~15K no-test (`app.ts` ~400 + `routes/*` ~1,6K + `console/*` ~7,4K + `terminal/*` ~4,4K + llanos ~10K) | ~10K en `services/gateway/src/*.test.ts` + ~5,5K en `tests/gateway-hardening/` |
| store (`packages/store/src`) | ~14,3K no-test (`repository.ts` 43 fachada + `repository/*` ~13K + 6 llanos) | ~19,5K en `packages/store/test/` |
| adapter-sdk (`packages/adapter-sdk/src`) | ~16,7K | ~19,9K en `packages/adapter-sdk/test/` |
| consola (`console/src`) | ~49K TS/TSX + ~5,6K CSS | ~21,6K en `console/src/**/*.test.ts(x)` |
| terminal-relay (`services/terminal-relay/src`) | ~10,4K | ~4,9K |
| telegram-bridge (`services/telegram-bridge/src`) | ~5,5K | ~5K en `services/telegram-bridge/test/` |
| dispatcher (`services/dispatcher/src`) | ~0,79K | ~0,32K en `services/dispatcher/test/` |
| pty-agent (Python) | ~8,5K (`cauce_pty_agent.py` 2,7K + `rollout_pty_lib.py` 0,7K + el resto de helpers y tests) | ~4,5K en `ops/pty-agent/tests/` |
| protocol (`packages/protocol/src`) | ~1,9K | ~1,1K en `packages/protocol/test/` |
| `tests/` raíz (gateway-hardening, terminal-pty, store-hardening, unit) | — | 17,3K |

La desproporción test/fuente y el tamaño del gateway/store son herencia de cómo se construyó; la carpintería ya rompió los gigantes de store (`repository.ts` de 11K → 42 fachada) y de gateway (`app.ts` 408 líneas); los >800 que quedan son piezas con cohesión interna real o trabajo pendiente de su sector (`ordenes/reportes/minimax-foto-final.md`).