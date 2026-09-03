#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPool } from '@cauce/store';
import { FleetReadModel } from './fleet-read-model.js';
import { createFleetToolServer } from './tool-server.js';

const tenantId = process.env.CAUCE_TENANT_ID;
if (!tenantId) {
  console.error('Error: CAUCE_TENANT_ID environment variable is required');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Error: DATABASE_URL environment variable is required');
  process.exit(1);
}

const ensuredTenantId: string = tenantId;
const ensuredDatabaseUrl: string = databaseUrl;

let pool: ReturnType<typeof createPool> | undefined;

async function main() {
  const transport = new StdioServerTransport();

  try {
    pool = createPool(ensuredDatabaseUrl);
    const fleetModel = new FleetReadModel(pool, ensuredTenantId);

    // Test the connection
    const testResult = await pool.query('SELECT 1');
    if (!testResult.rows.length) {
      throw new Error('Database connection test failed');
    }

    // Every tool filters on CAUCE_TENANT_ID against `connection_leases.tenant_id` and
    // `deliveries.recipient_tenant`. Validate that the configured tenant exists in the database.
    const known = await pool.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
    if (!known.rows.some((row) => row.id === ensuredTenantId)) {
      throw new Error(
        `CAUCE_TENANT_ID '${ensuredTenantId}' is not a known tenant. `
        + `Expected one of: ${known.rows.map((row) => row.id).join(', ')}. `
        + 'This must be a tenant id, not a room id.'
      );
    }

    console.error('[mcp-fleet-monitor] Connected to database');
    console.error(`[mcp-fleet-monitor] Tenant: ${ensuredTenantId}`);
    console.error('[mcp-fleet-monitor] Connecting stdio transport...');

    await createFleetToolServer(fleetModel).connect(transport);
    console.error('[mcp-fleet-monitor] Server running on stdio');
  } catch (error) {
    console.error('[mcp-fleet-monitor] Fatal error:', error);
    process.exit(1);
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.error('[mcp-fleet-monitor] Shutting down...');
  try {
    if (pool) await pool.end();
    process.exit(0);
  } catch (error) {
    console.error(`[mcp-fleet-monitor] Failed to shut down after ${signal}:`, error);
    process.exit(1);
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

main().catch(console.error);
