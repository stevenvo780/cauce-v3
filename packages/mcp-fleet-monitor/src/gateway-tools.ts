import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GatewayReader } from './gateway-client.js';
import { GatewayReadError } from './gateway-projection.js';
import { MCP_READ_SCOPE } from './gateway-authorization.js';

export const GATEWAY_TOOLS: Tool[] = [
  {
    name: 'cauce_status',
    description: 'Read protocol version and presence for the configured tenant visible to the gateway identity. Online is a presence count, not a health diagnosis.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'cauce_agents',
    description: 'List up to 100 visible agents in the configured tenant. Returns identifiers and registry/presence state only. No messages or runtime access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

export function createGatewayToolServer(reader: GatewayReader, oauth = false) {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Match the existing tested low-level MCP dispatch pattern.
  const server = new Server({ name: 'cauce-gateway-readonly', version: '1.0.0' }, { capabilities: { tools: {} } });
  const securitySchemes = [{ type: 'oauth2', scopes: [MCP_READ_SCOPE] }];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: GATEWAY_TOOLS.map((tool) => oauth ? { ...tool, securitySchemes, _meta: { securitySchemes } } : tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const error = (code: string) => ({ isError: true, content: [{ type: 'text' as const, text: code }] });
    if (Object.keys(request.params.arguments ?? {}).length > 0) return error('invalid_arguments');
    try {
      let result: unknown;
      switch (request.params.name) {
        case 'cauce_status': result = await reader.status(); break;
        case 'cauce_agents': result = await reader.agents(); break;
        default: return error('unknown_tool');
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (failure) {
      return error(failure instanceof GatewayReadError ? failure.code : 'gateway_unavailable');
    }
  });
  return server;
}
