# @cauce/mcp-fleet-monitor

Servidor MCP de solo lectura para observar la flota desde un agente: `fleet_status`, `deliveries`, `chain` (sigue una delegación A→B→C por trace), `dead_letters`, `health`.

**Registro:** no viene enchufado a nada. Darlo a un alias es decisión del dueño y se hace declarándolo como servidor MCP en la config del harness de ese alias — pasos en `INTEGRATION.md`, con `CAUCE_TENANT_ID` acotando lo que puede leer.

**Build:** `pnpm build:mcp`. **Probar:** incluido en `pnpm test:unit`.
