/* eslint @typescript-eslint/no-deprecated: "error" */
import { DeliveryStateSchema } from '@cauce/protocol';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { FleetReadModel } from './fleet-read-model.js';

/** Derived from the delivery state schema accepted by the durable store. */
const DELIVERY_STATUSES = DeliveryStateSchema.options;

export const FLEET_TOOLS: Tool[] = [
  {
    name: 'fleet_status',
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
    name: 'deliveries',
    description: 'List deliveries filtered by alias and/or status',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Optional: filter by recipient alias',
        },
        status: {
          type: 'string',
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
    name: 'chain',
    description: 'Get the delegation chain (A → B → C) for a given trace ID or root message ID',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'Trace ID to follow' },
        root_message_id: { type: 'string', description: 'Alternative: root message ID' },
      },
      required: [],
    },
  },
  {
    name: 'dead_letters',
    description: 'Get dead/stuck messages grouped by cause, with counts and recent examples',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'health',
    description: 'One-line fleet health summary suitable for chat',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

type ReadModel = Pick<
  FleetReadModel,
  'fleetStatus' | 'deliveries' | 'chain' | 'deadLetters' | 'health'
>;

function toolError(text: string): {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly isError: true;
} {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createFleetToolServer(fleetModel: ReadModel) {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Explicit low-level handlers keep tools/list and tools/call on one tested dispatch table.
  const server = new Server(
    { name: 'mcp-fleet-monitor', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FLEET_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};
    const alias = typeof args.alias === 'string' ? args.alias : undefined;
    const rawStatus = typeof args.status === 'string' ? args.status : undefined;
    let status: string | undefined;
    if (rawStatus !== undefined) {
      if (!DeliveryStateSchema.safeParse(rawStatus).success) {
        return toolError(
          `Invalid 'status' value '${rawStatus}'. Allowed: ${DELIVERY_STATUSES.join(', ')}`,
        );
      }
      status = rawStatus;
    }
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    const traceId = typeof args.trace_id === 'string' ? args.trace_id : undefined;
    const rootMessageId = typeof args.root_message_id === 'string'
      ? args.root_message_id
      : undefined;

    try {
      let result: unknown;
      switch (toolName) {
        case 'fleet_status':
          result = await fleetModel.fleetStatus(alias);
          break;
        case 'deliveries':
          result = await fleetModel.deliveries(alias, status, limit);
          break;
        case 'chain':
          result = await fleetModel.chain(traceId, rootMessageId);
          break;
        case 'dead_letters':
          result = await fleetModel.deadLetters();
          break;
        case 'health':
          result = await fleetModel.health();
          break;
        default:
          return toolError(`Unknown tool: ${toolName}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Error executing ${toolName}: ${message}`);
    }
  });

  return server;
}
