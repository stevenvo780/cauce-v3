# MCP Fleet Monitor - Integration Guide

This guide explains how to integrate the MCP Fleet Monitor into your workflow for real-time fleet monitoring.

## What is MCP Fleet Monitor?

The MCP Fleet Monitor is a Model Context Protocol (MCP) server that exposes read-only tools for monitoring the Cauce agent fleet. It allows any MCP client (Claude, custom tools, etc.) to query:

- **Fleet state**: Which aliases are alive, their lease status, and last activity
- **Deliveries**: Message delivery status across the fleet
- **Agent chains**: Trace delegations between agents
- **Dead letters**: Failed messages grouped by cause
- **Health**: One-line fleet status summary

## Installation

### Prerequisites

- Node.js >= 22
- PostgreSQL database (same as Cauce)
- MCP client (Claude Code, Claude.ai, or custom)

### Steps

1. **Build the package**:

```bash
cd /workspace/cauce-v3
pnpm install
pnpm -F @cauce/mcp-fleet-monitor build
```

The compiled server will be at:
```
packages/mcp-fleet-monitor/dist/server.js
```

2. **Set environment variables**:

```bash
export DATABASE_URL="postgresql://cauce:password@localhost:5432/cauce"
export CAUCE_TENANT_ID="Steven"  # Adjust for your tenant
```

3. **Test the server**:

```bash
node packages/mcp-fleet-monitor/dist/server.js
# Output:
# [mcp-fleet-monitor] Connected to database
# [mcp-fleet-monitor] Tenant: Steven
# [mcp-fleet-monitor] Connecting stdio transport...
# [mcp-fleet-monitor] Server running on stdio
```

The server is now ready. Use Ctrl+C to stop it.

## Integration with Claude Code

### Option 1: Via Claude Code Settings

Add to your Claude Code MCP servers config (typically `~/.claude/mcp.json` or via the UI):

```json
{
  "mcpServers": {
    "fleet-monitor": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-fleet-monitor/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://cauce:password@localhost:5432/cauce",
        "CAUCE_TENANT_ID": "Steven"
      }
    }
  }
}
```

### Option 2: Via Claude Code CLI

If using Claude Code CLI, create a config file `~/.claude/mcp.json`:

```bash
cat > ~/.claude/mcp.json << 'EOF'
{
  "mcpServers": {
    "fleet-monitor": {
      "command": "node",
      "args": ["/path/to/packages/mcp-fleet-monitor/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "CAUCE_TENANT_ID": "Steven"
      }
    }
  }
}
EOF
```

Then restart Claude Code for the config to take effect.

## Integration with Claude.ai / Claude Web

1. Log in to Claude.ai
2. Go to Settings → Connected applications
3. Add MCP server:
   - **Name**: Fleet Monitor
   - **Command**: `node`
   - **Arguments**: `/path/to/packages/mcp-fleet-monitor/dist/server.js`
   - **Environment**:
     - `DATABASE_URL=postgresql://...`
     - `CAUCE_TENANT_ID=Steven`

Claude will automatically load the server on connection.

## Using the Tools

Once integrated, Claude will have access to 5 tools:

### 1. estado_flota

Get current state of all aliases in the fleet.

**Parameters:**
- `alias` (optional): Filter to a specific alias

**Example:**

```
Claude: Can you check the status of jarvis?
@fleet-monitor estado_flota(alias="jarvis")
```

**Response:**

```json
{
  "data": [
    {
      "alias": "jarvis",
      "lease_alive": true,
      "active_instance_id": "kratos-1234",
      "lease_expires_at": "2026-07-25T15:00:00Z",
      "epoch": 42,
      "last_activity": "2026-07-25T14:50:00Z",
      "available": true
    }
  ],
  "available": true
}
```

### 2. entregas

List deliveries filtered by alias and/or status.

**Parameters:**
- `alias` (optional): Filter by recipient alias
- `estado` (optional): Filter by status (claimed, acked, dead)
- `limit` (optional, default 100): Max results

**Example:**

```
Claude: Show me dead deliveries for atlas.
@fleet-monitor entregas(alias="atlas", estado="dead", limit=10)
```

### 3. cadena

Follow a delegation chain from root to leaf.

**Parameters:**
- `trace_id` (optional): Trace to follow
- `mensaje_id_raiz` (optional): Root message ID

**Example:**

```
Claude: Show the delegation chain for trace abc123.
@fleet-monitor cadena(trace_id="abc123")
```

**Response:**

```json
{
  "data": [
    {
      "hop": 0,
      "source_alias": "jarvis",
      "target_alias": "atlas",
      "status": "delegated",
      "created_at": "2026-07-25T13:00:00Z"
    },
    {
      "hop": 1,
      "source_alias": "atlas",
      "target_alias": "argos",
      "status": "delegated",
      "created_at": "2026-07-25T13:05:00Z"
    }
  ],
  "trace_id": "abc123"
}
```

### 4. dead_letters

Get dead messages grouped by failure cause.

**Example:**

```
Claude: What's causing delivery failures?
@fleet-monitor dead_letters()
```

**Response:**

```json
{
  "data": [
    {
      "cause": "invalid_output",
      "count": 5,
      "recent_examples": [
        {
          "delivery_id": "del-123",
          "alias": "vulcano",
          "created_at": "2026-07-25T12:00:00Z"
        }
      ]
    }
  ],
  "available": true
}
```

### 5. salud

Get one-line health summary.

**Example:**

```
Claude: What's the fleet health?
@fleet-monitor salud()
```

**Response:**

```json
{
  "summary": "Flota: 14 alias, 9 vivos (degraded), 87% entregas OK",
  "timestamp": "2026-07-25T14:50:00Z"
}
```

## Typical Workflows

### Morning Health Check

```
Claude: Check fleet health and report any critical issues.

1. @fleet-monitor salud()
2. @fleet-monitor dead_letters()
3. @fleet-monitor estado_flota()
```

Claude will run all three tools and provide a summary.

### Debugging a Failed Delivery

```
Claude: I want to debug delivery del-12345. Show me what happened.

1. @fleet-monitor entregas() [to find the delivery]
2. @fleet-monitor cadena(trace_id="...") [to see the chain]
3. @fleet-monitor dead_letters() [to see error cause]
```

### Monitoring Specific Agent

```
Claude: Monitor atlas in real-time. Show its status and deliveries.

1. @fleet-monitor estado_flota(alias="atlas")
2. @fleet-monitor entregas(alias="atlas")
```

## Troubleshooting

### Server won't start

**Error**: `DATABASE_URL not set`

**Solution**: Ensure DATABASE_URL is exported before starting:
```bash
export DATABASE_URL="postgresql://..."
node packages/mcp-fleet-monitor/dist/server.js
```

**Error**: `Database connection test failed`

**Solution**: Verify the connection string and that PostgreSQL is running:
```bash
# Test connection manually
psql $DATABASE_URL
```

### No data returned from tools

**Cause**: CAUCE_TENANT_ID mismatch or empty database

**Solution**:
1. Verify tenant ID is correct: `echo $CAUCE_TENANT_ID`
2. Check database has data: `psql $DATABASE_URL -c "SELECT COUNT(*) FROM connection_leases WHERE tenant_id = 'Steven';"`

### MCP client doesn't see the server

**Cause**: Config file not reloaded

**Solution**: Restart Claude Code or refresh the web page

### Tools return empty `available: false`

**Cause**: Query failed or database unavailable

**Solution**: Check server stderr for error messages and database connectivity

## Security Considerations

- **Read-only**: All tools are read-only. No data mutations.
- **Tenant-scoped**: Queries are filtered by CAUCE_TENANT_ID. Cross-tenant access is prevented.
- **No secrets**: Auth sessions, credentials, and message bodies are omitted.
- **SQL injection safe**: All queries use parameterized statements.
- **Explicit errors**: If data cannot be fetched, tools return `available: false` rather than null values.

## Performance

- Average query time: 50-200ms (depending on data size)
- Max result sets: 1000 rows (configurable per tool)
- Connection pool: 20 concurrent connections (default)
- Graceful shutdown: All connections closed on SIGINT/SIGTERM

## Advanced Configuration

### Database Connection Options

The server accepts DATABASE_URL in these formats:

```
# Local
postgresql://cauce@localhost/cauce

# With password
postgresql://cauce:password@db.example.com:5432/cauce

# SSL required (production)
postgresql://cauce:password@db.example.com:5432/cauce?sslmode=verify-full
```

### Pool Configuration

To customize the connection pool, modify `src/server.ts`:

```typescript
pool = createPool(ensuredDatabaseUrl, {
  max: 50,  // Max concurrent connections
  connectionTimeoutMillis: 10_000,
});
```

### Query Limits

To change max result sizes, modify `src/fleet-read-model.ts`:

```typescript
const bounded = Math.min(Math.max(Number.isInteger(limit) ? limit : 100, 1), 10000);
```

## Support

For issues or questions:

1. Check TESTING.md for detailed test procedures
2. Review server stderr output for error details
3. Verify database connectivity and data availability
4. Consult README.md for API documentation

## Next Steps

After integration, consider:

- Setting up alerts for fleet health changes
- Creating dashboards that call these tools periodically
- Integrating with monitoring systems (Sentry, Datadog, etc.)
- Building custom workflows that combine tools with other actions
