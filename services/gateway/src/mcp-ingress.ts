import type { FastifyPluginAsync } from 'fastify';
import { createGatewayHttpHandler, type GatewayHttpOptions } from '@cauce/mcp-fleet-monitor/gateway-http';

export type McpIngressOptions = GatewayHttpOptions;

const METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

// The listener owner must configure header, connection and HTTP timeouts separately.
export const registerMcpIngress: FastifyPluginAsync<McpIngressOptions> = async (app, options) => {
  const handler = createGatewayHttpHandler(options);
  const host = new URL(options.publicOrigin).host;
  app.addHook('preClose', async () => { await handler.drain(); });
  for (const url of ['/mcp', METADATA_PATH]) {
    app.all(url, {
      onRequest: async (request, reply) => {
        const metadata = url === METADATA_PATH ? options.authorization.metadata : undefined;
        // RFC 9728 metadata is public: browser clients get credential-free CORS; /mcp keeps its Origin check.
        if (metadata !== undefined) {
          reply.raw.setHeader('access-control-allow-origin', '*');
          const foreign = request.headers.origin !== undefined && request.headers.origin !== options.publicOrigin;
          if (request.headers.host === host && (request.method === 'OPTIONS' || (request.method === 'GET' && foreign))) {
            reply.header('cache-control', 'no-store').header('access-control-allow-methods', 'GET, OPTIONS')
              .header('access-control-allow-headers', 'MCP-Protocol-Version').header('access-control-max-age', '600');
            return request.method === 'OPTIONS' ? reply.code(204).send() : reply.type('application/json').send(metadata);
          }
        }
        reply.hijack();
        handler(request.raw, reply.raw);
        return undefined;
      },
    }, async () => { throw new Error('MCP request was not hijacked'); });
  }
};
