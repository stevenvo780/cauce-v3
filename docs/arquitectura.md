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

## Flujo 1 — Un mensaje de A a B (orden de lectura)

| # | Archivo | Qué buscar |
|---|---|---|
| 1 | `packages/protocol/src/` | `PublishMessage`, la escalera de ACK, por qué el payload público NO lleva identidad |
| 2 | `services/gateway/src/app.ts` | `app.post('/v3/messages'` (publica y re-verifica el recibo) y `app.get('/v3/ws'` (el socket de los adapters) |
| 3 | `packages/store/src/repository.ts` (fachada) + `repository/{messages,outbox,jobs,config,observability,quotas}.ts` | `publish`, el claim de deliveries con fencing, los ACK. ~5,8K líneas en la fachada; 6 módulos extraídos (`messages`/`outbox`/`jobs`/`config`/`observability`/`quotas`); siguen dentro: deliveries, agents, fencing |
| 4 | `packages/adapter-sdk/src/sdk/engine.ts` | el bucle del consumidor durable |
| 5 | `packages/adapter-sdk/src/` → `paste-runner.ts`, `tmux.ts` | cómo se le pega el texto al CLI de verdad |
| 6 | `services/dispatcher/src/index.ts` + `handlers.ts` | el segador entero son ~850 líneas; `handlers.ts` dice explícitamente que ejecutar agentes NO es su trabajo |

## Flujo 2 — La TUI del agente en el navegador

| # | Archivo | Qué buscar |
|---|---|---|
| 1 | `apps/console/src/features/terminal/pty-connection.ts` (orquestador: `pty-session.ts`) | el cliente WS (xterm.js, reconexión, frames de control): `new WebSocket`, `openSocket`, `startViewerHeartbeat`, `stopHandshake/Reconnect` viven en `pty-connection.ts`; `pty-session.ts` los compone con `pty-input.ts`/`pty-output.ts`/`pty-theme.ts`/`pty-types.ts` |
| 2 | `apps/console/nginx.conf` | el proxy `/v3/console/terminal/ws` → relay :8446 con mTLS |
| 3 | `services/terminal-relay/src/browser-leg.ts` | la pierna del navegador (canjea el ticket contra el gateway) |
| 4 | `services/terminal-relay/src/agent-leg.ts` | la pierna del agente: TLS mutuo :8445, identidad por fingerprint, y el `superseded` que expulsa conexiones duplicadas |
| 5 | `ops/pty-agent/cauce_pty_agent.py` | tabla de tags al inicio; `_serve` (HELLO), `_resolve_command` (tmux/openclaw TUI), `_spawn` (pty.fork) |

## Flujo 3 — Editar CLAUDE.md / AGENTS.md / SOUL.md desde la web

| # | Archivo | Qué buscar |
|---|---|---|
| 1 | `apps/console/src/features/live/FicherosTab.tsx` (+ `DirectivaModal.tsx`) | el editor: lee inventario, lee contenido, guarda con `expected_sha` |
| 2 | `apps/console/src/api/client.ts` | `GET|PUT …/documents/:kind/content` |
| 3 | `services/gateway/src/console/agent-documents.routes.ts` | las 6 rutas |
| 4 | `services/gateway/src/console/agent-documents.ts` | `TerminalRelayFactsProbe`: read/write/list contra el relay |
| 5 | `services/terminal-relay/src/governance-relay.ts` + `framing.ts` | las operaciones read/write y los tags binarios 0x50–0x5E |
| 6 | `ops/pty-agent/cauce_pty_agent.py` | los handlers `TAG_READ` / `TAG_WRITE` (escritura con CAS y rollback) |

**Estado:** la cadena está completa en el repo; en producción solo hay lectura parcial desplegada. Se estrena entera en FASE 3 (`plan-reestructura/31`).

## Qué IGNORAR al leer

- `_legado/` — cuarentena de código sin uso. No es parte del sistema.
- `docs/bitacora/` — histórico congelado; miente sobre el presente.
- Los tests (≈45% del código) — léelos solo cuando toques esa pieza.
- `ops/` casi entero, salvo lo de la tabla siguiente.

## El mapa de `ops/` (la jungla, ordenada)

| Subdirectorio | Qué es | ¿Te importa? |
|---|---|---|
| `pty-agent/` | el agente de terminal (flujos 2 y 3) + su launcher y rollout | **Sí** |
| `systemd/` + `generated/` | plantillas de unidades y su salida generada (`pnpm ops:manifests`) | Cuando toques la flota |
| `manifests/` | un YAML de configuración por alias de agente | Cuando toques la flota |
| `guardias/` | espejos de los guardianes del host (los reales corren desde `/usr/local/sbin`) | FASE 3 (fichero 32) |
| `scripts/` | mitad utilidades vivas, mitad maquinaria de release en retirada (Codex la está moviendo a `_legado`) | Poco |
| `harness/`, `tests/`, `schemas/` | QA con dobles de protocolo y sus contratos | Poco |
| `observability/`, `config/` | Prometheus/otel y configs | Cuando toques alertas |
| el resto (`cli/`, `patches/`, `security/`, `openclaw-gateway/`, `container-runtime/`, `console-login/`, `ai-live/`, `private/`) | piezas puntuales, autoexplicativas por su README o candidatas a limpieza | Rara vez |

## Dónde vive lo operativo (fuera del repo)

- **Contenedores**: `docker ps` → `cauce-v3-prod-{gateway,dispatcher,terminal-relay,telegram-bridge,console,postgres,prometheus,otel-collector,outbox-metrics}`. Hoy corren imágenes del 23–25 ago (anteriores a lo último de main).
- **Base de datos**: `docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce`. Aplicada hasta la migración 024; la 026–037 se aplican en FASE 3.
- **systemd**: timers `cauce-*` (backups, guardianes, revividor) y unidades de usuario `cauce-v3-pty@<alias>`.
- **Deploy actual (legacy, se reemplaza en FASE 3)**: `/opt/cauce-v3` + overrides en `/etc/cauce-v3/`.
- **Archivo de la purga de ramas** (27-08): `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle`.

## Tamaños honestos (para calibrar antes de bucear)

| Área | Fuente | Tests |
|---|---|---|
| gateway | ~25K | (en `tests/gateway-hardening` + unit) |
| store | ~15K | ~20K |
| adapter-sdk | ~17K | ~20K |
| consola | ~30K | ~23K |
| terminal-relay | ~5K | ~4K |
| telegram-bridge | ~5,5K | ~5K |
| dispatcher | ~0,85K | — |
| pty-agent (Python) | ~2,7K | — |

La desproporción test/fuente y el tamaño del gateway/store son herencia de cómo se construyó; la carpintería en curso (plan 13/14) lo está partiendo en piezas legibles.
