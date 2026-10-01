#!/usr/bin/env node
import { createGatewayReader } from './gateway-client.js';
import { gatewayBridgeConfiguration } from './gateway-configuration.js';
import { createGatewayHttpServer } from './gateway-http.js';
import { createGatewayAuthorization } from './gateway-authorization.js';

async function main(): Promise<void> {
  const config = gatewayBridgeConfiguration();
  const reader = await createGatewayReader(config.gateway);
  const authorization = createGatewayAuthorization(config.publicOrigin, config.authentication);
  const server = createGatewayHttpServer({ reader, authorization, publicOrigin: config.publicOrigin });
  server.on('error', () => {
    console.error('Cauce MCP listener failed');
    process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () => { console.error('Cauce read-only MCP listening on loopback'); });
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(() => {
  console.error('Cauce MCP startup failed; verify the required environment and TLS files');
  process.exitCode = 1;
});
