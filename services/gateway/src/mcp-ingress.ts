import type { FastifyPluginAsync } from 'fastify';
import { createGatewayHttpHandler, type GatewayHttpOptions } from '@cauce/mcp-fleet-monitor/gateway-http';

export type McpIngressOptions = GatewayHttpOptions;

// The listener owner must configure header, connection and HTTP timeouts separately.
export const registerMcpIngress: FastifyPluginAsync<McpIngressOptions> = async (app, options) => {
  const handler = createGatewayHttpHandler(options);
  app.addHook('preClose', async () => { await handler.drain(); });
  for (const url of ['/mcp', '/.well-known/oauth-protected-resource/mcp']) {
    app.all(url, {
      onRequest: async (request, reply) => {
        reply.hijack();
        handler(request.raw, reply.raw);
      },
    }, async () => { throw new Error('MCP request was not hijacked'); });
  }
};
