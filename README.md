# Cauce V3

Bus de mensajería durable entre agentes de IA en CLI (Claude Code, Codex, OpenClaw) de 4 tenants (Steven, Miguel, Jhon, Isa), con consola web de operador y puente Telegram. PostgreSQL es la única fuente durable; la entrega es *pull* por WebSocket con fencing (`claim_token`+`epoch`). Monorepo pnpm (Node 22, TypeScript) + un agente PTY en Python. Corre en producción desde el primer despliegue real (ver `docs/roadmap.md` para el estado actual y lo pendiente).

**¿Primera vez aquí (humano o IA)?** Empieza por [`AGENTS.md`](AGENTS.md) (contexto y reglas) y [`docs/arquitectura.md`](docs/arquitectura.md) (cómo está construido).

## Instalar, probar, desplegar

```sh
git pull                                     # el árbol es compartido; siempre al día antes de empezar
pnpm install --frozen-lockfile               # dependencias
pnpm prepare:runtime                         # compila packages/protocol primero
pnpm typecheck                               # tipos: core+adapter+mcp+console
pnpm lint                                    # ESLint por zona + ruff + trinquete de calidad
pnpm test:unit                               # gate de todo commit
pnpm test                                    # gate completo (scripts/test-all.mjs)
ops/scripts/validate.sh                      # sintaxis ops/deploy + identidad byte a byte de lo generado
export CAUCE_FASE3_CON_DUENO=si CAUCE_DEPLOY_CONFIRMADO=si
./deploy/deploy.sh                           # despliegue real — SOLO con el dueño presente (ver docs/operacion.md)
./deploy/smoke.sh                            # 7 sondas post-despliegue sobre producción viva
```

## Componentes

| Componente | Qué es |
|---|---|
| [`packages/protocol`](packages/protocol/README.md) | schemas Zod del wire 3.0; payload público sin identidad; se compila primero |
| [`packages/store`](packages/store/README.md) | SQL, migraciones y repositorio PostgreSQL |
| [`packages/adapter-sdk`](packages/adapter-sdk/README.md) | conecta un CLI real a Cauce: WS durable, ACKs, sesión tmux |
| [`packages/mcp-fleet-monitor`](packages/mcp-fleet-monitor/README.md) | MCP de observación de flota |
| [`services/gateway`](services/gateway/README.md) | HTTP/WS, frontera de identidad, fachadas `/v3/console/*`, plano de terminal |
| [`services/dispatcher`](services/dispatcher/README.md) | segador de reintentos (no entrega mensajes) |
| [`services/terminal-relay`](services/terminal-relay/README.md) | puente navegador↔pty-agent con TLS mutuo |
| [`services/telegram-bridge`](services/telegram-bridge/README.md) | polling/egress Telegram con cursor y lease cercados |
| [`console`](console/README.md) | SPA React del operador |
| [`ops/pty-agent`](ops/pty-agent/README.md) | agente Python dentro de cada contenedor: PTY + ficheros de gobierno |

## Documentación

| Doc | Contenido |
|---|---|
| [`docs/doctrina-del-dueno.md`](docs/doctrina-del-dueno.md) | el criterio del dueño detrás de las reglas |
| [`docs/arquitectura.md`](docs/arquitectura.md) | cómo está construido el sistema — guía de lectura central |
| [`docs/operacion.md`](docs/operacion.md) | desplegar, alta/baja de agente, diagnóstico, backups |
| [`docs/roadmap.md`](docs/roadmap.md) | qué falta, priorizado |
| [`docs/flota-y-participantes.md`](docs/flota-y-participantes.md) | máquinas, humanos, agentes, escenarios esenciales |
| [`docs/adr/`](docs/adr/) | decisiones de diseño aceptadas |
| [`docs/threat-model.md`](docs/threat-model.md) | amenazas y controles |
| [`ops/runbooks/`](ops/runbooks/) | procedimientos operativos detallados |
| [`ordenes/00-PROTOCOLO.md`](ordenes/00-PROTOCOLO.md) | cómo conviven varias instancias en `dev` sin pisarse |

Reglas de trabajo completas para agentes de IA: `AGENTS.md` (puntero también desde `CLAUDE.md` y `GEMINI.md`).
