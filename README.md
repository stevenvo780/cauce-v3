# Cauce V3

Bus de mensajería durable entre agentes de IA en CLI (Claude Code, Codex, OpenClaw) de 4 tenants (Steven, Miguel, Jhon, Isa), con consola web de operador y puente Telegram. Monorepo pnpm (Node 22, TypeScript) + un agente PTY en Python.

## Cómo funciona de verdad

- **PostgreSQL es la única fuente durable.** Mensajes, entregas, ACKs, leases y outbox viven en la base; los WebSockets solo aceleran.
- **La entrega es *pull*.** El adapter de cada agente mantiene un WS contra el gateway (`/v3/ws`), reclama entregas con `claim_token`+`epoch` (fencing real) y confirma con la escalera `accepted → started → done|failed`. El `dispatcher` **no reparte nada**: es el segador (reintentos de entregas rancias, poda de observabilidad).
- **El canal de entrada más usado es Telegram** (`telegram-bridge`), no la consola.
- Entregar un mensaje a un agente CLI significa pegarle el texto a su sesión tmux viva (`adapter-sdk`).

## Estado (2026-08-27)

- La mensajería IA↔IA **funciona en producción** (contenedores `cauce-v3-prod-*` en esta máquina).
- Producción corre imágenes del 23–25 de agosto y **la base está en la migración 024 de 037**. Todo lo commiteado después (editor de ficheros de gobierno completo, separación PTY/TUI) está **escrito pero sin desplegar** — no existe hoy un camino verde de despliegue; se construye en `plan-reestructura/31`.
- El repo está en reestructura activa por 4 instancias de IA con sectores disjuntos: ver `ordenes/00-PROTOCOLO.md` (obligatorio antes de tocar nada) y `plan-reestructura/`.
- `_legado/` es cuarentena de código medido como nunca-usado. No se compila ni se importa.

## Componentes vivos

| Componente | Qué es |
|---|---|
| [`packages/protocol`](packages/protocol/README.md) | Schemas Zod del wire 3.0; payload público sin identidad; se compila primero |
| [`packages/store`](packages/store/README.md) | SQL, migraciones y repositorio PostgreSQL |
| [`packages/adapter-sdk`](packages/adapter-sdk/README.md) | Conecta un CLI real a Cauce: WS durable, ACKs, sesión tmux |
| [`packages/mcp-fleet-monitor`](packages/mcp-fleet-monitor/README.md) | MCP de observación de flota (sin registrar en ningún alias hoy) |
| [`services/gateway`](services/gateway/README.md) | HTTP/WS, frontera de identidad, fachadas `/v3/console/*`, plugin de terminal |
| [`services/dispatcher`](services/dispatcher/README.md) | Segador de reintentos (843 líneas; no entrega mensajes) |
| [`services/terminal-relay`](services/terminal-relay/README.md) | Puente navegador↔pty-agent con TLS mutuo |
| [`services/telegram-bridge`](services/telegram-bridge/README.md) | Polling/egress Telegram con cursor y lease cercados |
| [`apps/console`](apps/console/README.md) | SPA React del operador (live, mensajes, colas, config, terminal) |
| [`ops/pty-agent`](ops/pty-agent/README.md) | Agente Python dentro del contenedor de cada alias: PTY + lectura/escritura de ficheros de gobierno |

## Desarrollo

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint      # gate mínimo de todo commit
pnpm test:unit                   # gate completo cuando ordenes/codex.md tarea 2 esté cerrada
```

Reglas de trabajo, sectores por instancia y prohibiciones: `ordenes/00-PROTOCOLO.md`. Contexto para agentes de IA: `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`.

## Despliegue

**Hoy no hay procedimiento de despliegue utilizable** (la maquinaria anterior exigía evidencia imposible y está en cuarentena). El despliegue simple —build con label de commit, pin por digest, migraciones, smoke test del efecto real— se implementa en FASE 3 con el dueño presente: `plan-reestructura/31-despliegue-simple.md`. Hasta entonces, nadie toca producción.

## Referencias

- Plan vigente: `plan-reestructura/` · Órdenes por instancia: `ordenes/`
- Decisiones de diseño: `docs/adr/` · Modelo de amenazas: `docs/threat-model.md`
- Histórico (no confiable como estado actual): `docs/bitacora/`
- Archivo de la purga de ramas del 27-08: `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle`
