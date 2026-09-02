# @cauce/mcp-fleet-monitor

Servidor MCP de solo lectura para observar la flota desde un agente: `fleet_status`, `deliveries`, `chain` (sigue una delegación A→B→C por trace), `dead_letters`, `health`.

**Estado real a 2026-08-27:** escrito y con tests, pero **no está registrado como servidor MCP de ningún alias** — nadie lo usa todavía. Conectarlo a la flota es decisión del dueño (candidato natural: dárselo a los alias operadores en FASE 3).

**Build:** `pnpm build:mcp`. **Probar:** incluido en `pnpm test:unit`.
