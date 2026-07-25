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
export CAUCE_TENANT_ID="grp.steven"
```

## Running the Server

### Development Mode

```bash
pnpm -F @cauce/mcp-fleet-monitor dev
```

The server will start and output logs to stderr:

```
[mcp-fleet-monitor] Connected to database
[mcp-fleet-monitor] Tenant: grp.steven
[mcp-fleet-monitor] Connecting stdio transport...
[mcp-fleet-monitor] Server running on stdio
```

### Production Mode

```bash
node packages/mcp-fleet-monitor/dist/src/server.js
```

## Testing with MCP Client

Once the server is running, you can test it with an MCP client. The server implements the StdIO protocol.

### Using `mcp` CLI (if available)

```bash
# Test tool listing
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  DATABASE_URL="..." CAUCE_TENANT_ID="..." node packages/mcp-fleet-monitor/dist/src/server.js
```

### Using Claude

Add to your MCP config (e.g., `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "fleet-monitor": {
      "command": "node",
      "args": ["/path/to/packages/mcp-fleet-monitor/dist/src/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "CAUCE_TENANT_ID": "grp.steven"
      }
    }
  }
}
```

Then ask Claude to use the tools:

```
@fleet-monitor estado_flota
```

Claude will respond with the current fleet state.

## Testing Specific Tools

### estado_flota

Get all aliases:

```
estado_flota()
```

Filter by one alias:

```
estado_flota(alias="jarvis")
```

**Expected response:**

```json
{
  "data": [
    {
      "alias": "jarvis",
      "lease_alive": true,
      "active_instance_id": "kratos-12345",
      "lease_expires_at": "2026-07-25T14:30:00.000Z",
      "epoch": 42,
      "last_activity": "2026-07-25T14:20:00.000Z",
      "available": true
    }
  ],
  "available": true
}
```

### entregas

List recent deliveries:

```
entregas()
```

Filter by status:

```
entregas(estado="acked", limit=10)
```

**Expected response:**

```json
{
  "data": [
    {
      "id": "del-uuid-123",
      "message_id": "msg-uuid-456",
      "recipient_alias": "atlas",
      "status": "acked",
      "attempt": 1,
      "max_attempts": 3,
      "created_at": "2026-07-25T14:00:00.000Z",
      "available": true
    }
  ],
  "available": true
}
```

### cadena

Follow a trace:

```
cadena(trace_id="some-trace-id")
```

**Expected response:**

```json
{
  "data": [
    {
      "hop": 0,
      "source_alias": "jarvis",
      "source_tenant": "grp.steven",
      "target_alias": "atlas",
      "target_tenant": "grp.steven",
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
          "alias": "vulcano",
          "created_at": "2026-07-25T12:00:00.000Z"
        }
      ]
    }
  ],
  "available": true
}
```

### salud

```
salud()
```

**Expected response:**

```json
{
  "summary": "Flota: 14 alias, 9 vivos (degraded), 87% entregas OK",
  "timestamp": "2026-07-25T14:03:00.000Z"
}
```

## Unit Tests

Run the test suite:

```bash
pnpm -F @cauce/mcp-fleet-monitor test
```

Tests are skipped if DATABASE_URL is not set (they require a real database connection).

## Troubleshooting

### "Cannot connect to database"

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
- Queries are limited to reasonable result sets (default 100-1000 rows)
- The server maintains a persistent pool connection (20 max by default)
- Graceful shutdown on SIGINT/SIGTERM closes the pool
