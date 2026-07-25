# MCP Fleet Monitor

A Model Context Protocol (MCP) server for read-only monitoring of the Cauce agent fleet.

## Features

Exposes 5 tools for fleet introspection:

- **`estado_flota`**: Get the current state of all aliases (lease status, last activity, epoch)
- **`entregas`**: List deliveries filtered by alias and/or status (claimed, acked, dead)
- **`cadena`**: Follow the delegation chain (agent A → B → C) for a given trace ID
- **`dead_letters`**: Get dead/stuck messages grouped by rejection cause
- **`salud`**: One-line fleet health summary suitable for pasting in chat

## Installation

### Prerequisites

- Node.js >= 22
- PostgreSQL connection (DATABASE_URL)
- CAUCE_TENANT_ID (a tenant id such as "Steven", never a room id like "grp.steven")

### Setup

1. Build the package:

```bash
cd /workspace/cauce-v3
pnpm install
pnpm -F @cauce/mcp-fleet-monitor build
```

2. Run the server:

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/cauce"
export CAUCE_TENANT_ID="Steven"
node packages/mcp-fleet-monitor/dist/server.js
```

Or in development mode:

```bash
pnpm -F @cauce/mcp-fleet-monitor dev
```

## MCP Integration

### For Claude Code / Claude.ai

Add this to your MCP config (typically `~/.claude/mcp.json` or via Claude Code settings):

```json
{
  "mcpServers": {
    "fleet-monitor": {
      "command": "node",
      "args": ["<path>/packages/mcp-fleet-monitor/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "CAUCE_TENANT_ID": "Steven"
      }
    }
  }
}
```

### For Other MCP Clients

The server implements the MCP StdIO protocol. Start it with the environment variables set, then connect your client to its stdin/stdout.

## Tool Examples

### estado_flota

List all aliases:

```
estado_flota()
→ {
    "data": [
      {
        "alias": "jarvis",
        "lease_alive": true,
        "active_instance_id": "kratos-instance-123",
        "lease_expires_at": "2026-07-25T13:45:00Z",
        "epoch": 42,
        "last_activity": "2026-07-25T13:30:00Z",
        "available": true
      },
      ...
    ],
    "available": true
  }
```

Filter by alias:

```
estado_flota(alias="jarvis")
```

### entregas

List all deliveries:

```
entregas()
```

Filter by status:

```
entregas(estado="dead", limit=50)
```

### cadena

Follow a trace:

```
cadena(trace_id="abc123def456")
→ {
    "data": [
      {
        "hop": 0,
        "source_alias": "jarvis",
        "source_tenant": "Steven",
        "target_alias": "atlas",
        "target_tenant": "Steven",
        "status": "delegated",
        "created_at": "2026-07-25T13:00:00Z"
      },
      ...
    ],
    "trace_id": "abc123def456"
  }
```

### dead_letters

```
dead_letters()
→ {
    "data": [
      {
        "cause": "invalid_output",
        "count": 5,
        "recent_examples": [
          {
            "delivery_id": "del-123",
            "alias": "vulcano",
            "created_at": "2026-07-25T12:00:00Z"
          },
          ...
        ]
      },
      ...
    ]
  }
```

### salud

```
salud()
→ {
    "summary": "Flota: 14 alias, 9 vivos (degraded), 87% entregas OK",
    "timestamp": "2026-07-25T13:45:00Z"
  }
```

## Security

- **Read-only**: All tools perform SELECT queries only. No mutations.
- **No secrets**: Auth sessions, credentials, and message bodies are omitted from responses.
- **Tenant-scoped**: All queries are filtered by CAUCE_TENANT_ID; cross-tenant access is prevented.
- **Explicit unavailable**: If data cannot be fetched, returns `{"available": false}` rather than null/zero.

## Testing

```bash
# Run unit tests
pnpm -F @cauce/mcp-fleet-monitor test

# Type checking
pnpm -F @cauce/mcp-fleet-monitor typecheck

# Start in dev mode and test manually
pnpm -F @cauce/mcp-fleet-monitor dev
```

## Troubleshooting

### "DATABASE_URL not set"
Ensure the environment variable is exported before starting the server.

### "Database connection test failed"
Check that the PostgreSQL connection is valid and the database exists.

### "CAUCE_TENANT_ID not set"
Specify the tenant ID (e.g., "Steven") to scope queries. It must be a tenant, not a room id such as "grp.steven"; the server now refuses to start on an unknown tenant.

### No data returned
Verify that the tenant ID matches the data in your database, and that the leases/deliveries tables contain records for that tenant.

## Architecture

The server is implemented as a stateless StdIO server:

- `server.ts`: MCP protocol handler and tool definitions
- `fleet-read-model.ts`: Read-only business logic for each tool
- Database pool is created once at startup and reused for all requests
- Graceful shutdown on SIGINT/SIGTERM

## Dependencies

- `@cauce/store`: Database abstraction and pool management
- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `pg`: PostgreSQL client (transitive from @cauce/store)
