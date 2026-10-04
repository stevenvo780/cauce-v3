import { request } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredHumanMcp } from './mcp-configuration.js';
import { humanMcpListenerOptions } from './mcp-mounting.js';
import { buildTestGateway } from './test-support/gateway-doubles.js';

const origin = 'https://mcp.example';
const metadataPath = '/.well-known/oauth-protected-resource/mcp';
const configuration = configuredHumanMcp({
  CAUCE_MCP_PUBLIC_ORIGIN: origin,
  CAUCE_MCP_OAUTH_ISSUER: 'https://issuer.example',
  CAUCE_MCP_OAUTH_JWKS_URI: 'https://issuer.example/jwks',
});
const applications: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => { await app.close(); }));
});

async function mounted(enabled = true): Promise<FastifyInstance> {
  if (configuration === undefined) throw new Error('missing human MCP fixture configuration');
  const app = await buildTestGateway(enabled ? { humanMcp: configuration } : {});
  applications.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

async function send(
  app: FastifyInstance, path: string, method = 'GET', body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number | undefined; headers: Record<string, unknown>; body: string }> {
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('missing mounted gateway listener');
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, method, path,
      headers: { host: 'mcp.example', ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
      },
    }, (response) => {
      let payload = '';
      response.on('data', (chunk: Buffer) => { payload += chunk.toString('utf8'); });
      response.once('end', () => { resolve({ status: response.statusCode, headers: response.headers, body: payload }); });
    });
    req.once('error', reject);
    req.end(body);
  });
}

describe('human MCP mounted on the existing gateway listener', () => {
  it('preserves disabled listener options and TLS client verification', () => {
    const https = { requestCert: true, rejectUnauthorized: true, ca: Buffer.from('fixture CA') };
    expect(humanMcpListenerOptions(undefined, undefined)).toEqual({});
    expect(humanMcpListenerOptions(undefined, https).https).toBe(https);
    expect(humanMcpListenerOptions(configuration, https)).toMatchObject({
      https: { requestCert: true, rejectUnauthorized: true, ca: https.ca, maxHeaderSize: 16384 },
      requestTimeout: 10000, keepAliveTimeout: 1000,
    });
  });

  it('leaves both MCP resources absent when configuration is disabled', async () => {
    const app = await mounted(false);
    expect((await send(app, metadataPath)).status).toBe(404);
    expect((await send(app, '/mcp', 'POST', '{}')).status).toBe(404);
  });

  it('serves canonical discovery and rejects unauthenticated malformed JSON before parsing', async () => {
    const app = await mounted();
    const discovery = await send(app, metadataPath);
    expect(discovery.status).toBe(200);
    expect(discovery.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(discovery.body) as unknown).toMatchObject({
      resource: origin + '/mcp', authorization_servers: ['https://issuer.example'],
      scopes_supported: ['cauce.read', 'cauce.publish'],
    });
    const denied = await send(app, '/mcp', 'POST', '{malformed');
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toBe('Bearer resource_metadata="' + origin + metadataPath + '"');
    expect((await send(app, '/mcp', 'POST', '{malformed', { authorization: 'Bearer invalid' })).status).toBe(401);
    expect(app.server.requestTimeout).toBe(10000);
    expect(app.server.headersTimeout).toBe(10000);
    expect(app.server.keepAliveTimeout).toBe(1000);
    expect(app.server.maxHeadersCount).toBe(64);
    expect(app.server.maxConnections).toBe(64);
  });

  it('preserves raw Host/Origin guards, exact paths and the listener header-size bound', async () => {
    const app = await mounted();
    expect((await send(app, metadataPath, 'GET', undefined, { host: 'wrong.example' })).status).toBe(403);
    expect((await send(app, '/mcp', 'POST', '{}', { origin: 'https://wrong.example' })).status).toBe(403);
    expect((await send(app, metadataPath + '?extra=1')).status).toBe(404);
    expect((await send(app, '/mcp/', 'POST', '{}')).status).toBe(404);
    expect((await send(app, metadataPath, 'GET', undefined, { 'x-large': 'a'.repeat(20 * 1024) })).status).toBe(431);
  });
});
