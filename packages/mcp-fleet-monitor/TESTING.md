# Testing MCP Fleet Monitor

This document describes how to test the MCP Fleet Monitor server.

## Setup

1. Build the package:

```bash
pnpm -F @cauce/mcp-fleet-monitor build
```

2. Set environment variables:

```bash
export DATABASE_URL="postgresql://cauce:password@localhost:5432/cauce"
export CAUCE_TENANT_ID="<tenant>"
```

## Running the Server

### Development Mode

```bash
pnpm -F @cauce/mcp-fleet-monitor dev
```

The server will start and output logs to stderr:

```
[mcp-fleet-monitor] Connected to database
[mcp-fleet-monitor] Tenant: <tenant>
[mcp-fleet-monitor] Connecting stdio transport...
[mcp-fleet-monitor] Server running on stdio
```

### Production Mode

```bash
node packages/mcp-fleet-monitor/dist/server.js
```

## Testing with MCP Client

Once the server is running, you can test it with an MCP client. The server implements the StdIO protocol.

### Using `mcp` CLI (if available)

```bash
# Test tool listing
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  DATABASE_URL="..." CAUCE_TENANT_ID="..." node packages/mcp-fleet-monitor/dist/server.js
```

### Using Claude

Add to your MCP config (e.g., `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "fleet-monitor": {
      "command": "node",
      "args": ["/path/to/packages/mcp-fleet-monitor/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "CAUCE_TENANT_ID": "<tenant>"
      }
    }
  }
}
```

Then ask Claude to use the tools:

```
@fleet-monitor fleet_status
```

Claude will respond with the current fleet state.

## Testing Specific Tools

### fleet_status

Get all aliases:

```
fleet_status()
```

Filter by one alias:

```
fleet_status(alias="<alias>")
```

**Expected response:**

```json
{
  "data": [
    {
      "alias": "<alias>",
      "lease_alive": true,
      "active_instance_id": "<instance-id>",
      "lease_expires_at": "2026-07-25T14:30:00.000Z",
      "epoch": 42,
      "last_activity": "2026-07-25T14:20:00.000Z",
      "available": true
    }
  ],
  "available": true
}
```

### deliveries

List recent deliveries:

```
deliveries()
```

Filter by status:

```
deliveries(status="done", limit=10)
```

**Expected response:**

```json
{
  "data": [
    {
      "id": "del-uuid-123",
      "message_id": "msg-uuid-456",
      "recipient_alias": "<alias>",
      "status": "done",
      "attempt": 1,
      "max_attempts": 3,
      "created_at": "2026-07-25T14:00:00.000Z",
      "available": true
    }
  ],
  "available": true
}
```

### chain

Follow a trace:

```
chain(trace_id="some-trace-id")
```

**Expected response:**

```json
{
  "data": [
    {
      "hop": 0,
      "source_alias": "<alias-a>",
      "source_tenant": "<tenant>",
      "target_alias": "<alias-b>",
      "target_tenant": "<tenant>",
      "status": "delegated",
      "created_at": "2026-07-25T13:00:00.000Z"
    }
  ],
  "available": true,
  "trace_id": "some-trace-id"
}
```

### dead_letters

```
dead_letters()
```

**Expected response:**

```json
{
  "data": [
    {
      "cause": "invalid_output",
      "count": 5,
      "recent_examples": [
        {
          "delivery_id": "del-uuid-123",
          "alias": "<alias>",
          "created_at": "2026-07-25T12:00:00.000Z"
        }
      ]
    }
  ],
  "available": true
}
```

### health

```
health()
```

**Expected response:**

```json
{
  "summary": "Flota: 3 alias, 2 vivos (degraded), 87% entregas OK",
  "timestamp": "2026-07-25T14:03:00.000Z"
}
```

## Unit Tests

Run the test suite:

```bash
pnpm -F @cauce/mcp-fleet-monitor test
```

`vitest run` usa un pool simulado (`fleet-read-model.test.ts`) y no se salta por `DATABASE_URL`. La suite de integración (`tests/integration/mcp-fleet-monitor-tools.test.ts`) no la ejecuta ese comando. Si `CAUCE_TEST_DATABASE_URL` no está definida, esa suite llama a `skipIfUnavailable` y se omite solo cuando Docker no está. No mira `DATABASE_URL`.

## Troubleshooting

### Fallo de conexión

El servidor no emite «Cannot connect to database». Si falta `DATABASE_URL` sale `Error: DATABASE_URL environment variable is required`. Si `SELECT 1` no devuelve fila, lanza `Database connection test failed`. Cualquier otro fallo de arranque se registra como `[mcp-fleet-monitor] Fatal error:` seguido del error de `pg` (`server.ts`).

- Verify `DATABASE_URL` is set correctly
- Check that PostgreSQL is running
- Ensure the user has permissions to connect

### "No data returned"

- Verify `CAUCE_TENANT_ID` is correct
- Check that the database contains data for that tenant
- Verify leases/deliveries tables have records

### Server exits immediately

- Check stderr output for error messages
- Ensure both `DATABASE_URL` and `CAUCE_TENANT_ID` are set
- Verify database connection parameters

## Performance Notes

- All queries use parameterized statements (SQL injection safe)
- `deliveries` acota el límite entre 1 y 1000 (por defecto 100). `chain` usa `LIMIT 500` fijo. `fleet_status` no tiene `LIMIT`. El agrupado de `dead_letters` tampoco; sus ejemplos sí, con `LIMIT 3`
- The server maintains a persistent pool connection (20 max by default)
- Graceful shutdown on SIGINT/SIGTERM closes the pool
