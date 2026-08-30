#!/usr/bin/env node
/* eslint @typescript-eslint/no-deprecated: "error" */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DeliveryStateSchema } from '@cauce/protocol';
import { createPool } from '@cauce/store';
import { FleetReadModel } from './fleet-read-model.js';

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
let fleetModel: FleetReadModel | undefined;

// eslint-disable-next-line @typescript-eslint/no-deprecated -- Low-level handlers preserve the advertised schema and explicit tool-error contract.
const server = new Server(
  {
    name: 'mcp-fleet-monitor',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/** Derived from `@cauce/protocol`'s DeliveryStateSchema; the enum the deliveries table accepts. */
const DELIVERY_STATUSES = DeliveryStateSchema.options;

const TOOLS = [
  {
    name: 'estado_flota',
    description:
      'Get the current state of all aliases in the fleet, including lease status, harness status, and last activity',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Optional: filter by specific alias',
        },
      },
      required: [],
    },
  },
  {
    name: 'entregas',
    description:
      'List deliveries filtered by alias and/or status',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Optional: filter by recipient alias',
        },
        estado: {
          type: 'string',
          // Matches the deliveries.status CHECK constraint in migration 001.
          enum: DELIVERY_STATUSES,
          description: 'Optional: filter by delivery status',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 100, max 1000)',
        },
      },
      required: [],
    },
  },
  {
    name: 'cadena',
    description:
      'Get the delegation chain (A → B → C) for a given trace ID or root message ID',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: {
          type: 'string',
          description: 'Trace ID to follow',
        },
        mensaje_id_raiz: {
          type: 'string',
          description: 'Alternative: root message ID',
        },
      },
      required: [],
    },
  },
  {
    name: 'dead_letters',
    description:
      'Get dead/stuck messages grouped by cause, with counts and recent examples',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'salud',
    description: 'One-line fleet health summary suitable for chat',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!fleetModel) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: fleet model not initialized',
        },
      ],
      isError: true,
    };
  }

  const toolName = request.params.name;
  const args = request.params.arguments ?? {};

  try {
    let result: unknown;

    const aliasArg = typeof args.alias === 'string' ? args.alias : undefined;
    const rawEstado = typeof args.estado === 'string' ? args.estado : undefined;
    let estadoArg: string | undefined;
    if (rawEstado !== undefined) {
      const parsed = DeliveryStateSchema.safeParse(rawEstado);
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid 'estado' value '${rawEstado}'. Allowed: ${DELIVERY_STATUSES.join(', ')}`,
            },
          ],
          isError: true,
        };
      }
      estadoArg = rawEstado;
    }
    const limitArg = typeof args.limit === 'number' ? args.limit : undefined;
    const traceIdArg = typeof args.trace_id === 'string' ? args.trace_id : undefined;
    const msgIdArg = typeof args.mensaje_id_raiz === 'string' ? args.mensaje_id_raiz : undefined;

    switch (toolName) {
      case 'estado_flota':
        result = await fleetModel.estadoFlota(aliasArg);
        break;
      case 'entregas':
        result = await fleetModel.entregas(aliasArg, estadoArg, limitArg);
        break;
      case 'cadena':
        result = await fleetModel.cadena(traceIdArg, msgIdArg);
        break;
      case 'dead_letters':
        result = await fleetModel.deadLetters();
        break;
      case 'salud':
        result = await fleetModel.salud();
        break;
      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${toolName}`,
            },
          ],
          isError: true,
        };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `Error executing ${toolName}: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();

  try {
    pool = createPool(ensuredDatabaseUrl);
    fleetModel = new FleetReadModel(pool, ensuredTenantId);

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

    await server.connect(transport);
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
