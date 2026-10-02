import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSelfSignedCert, type SelfSignedCert } from '../../../tests/terminal-pty/certs.mjs';
import { createGatewayReader, MAX_GATEWAY_BYTES } from './gateway-client.js';

let tls: SelfSignedCert;
let server: Server;
let origin: string;
const requests: { method: string | undefined; path: string | undefined; headers: IncomingMessage['headers']; authorized: boolean }[] = [];
let respond: (request: IncomingMessage, response: ServerResponse) => void;

beforeAll(async () => {
  tls = createSelfSignedCert();
  server = createServer({ key: tls.key, cert: tls.cert, ca: tls.cert, requestCert: true, rejectUnauthorized: false }, (request, response) => {
    requests.push({ method: request.method, path: request.url, headers: request.headers, authorized: (request.socket as TLSSocket).authorized });
    respond(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture listener');
  origin = `https://127.0.0.1:${String(address.port)}`;
});

afterEach(() => { requests.length = 0; server.closeAllConnections(); });
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
  await rm(tls.directory, { recursive: true, force: true });
});

const bearerToken = 'gateway-test-fixture-token';
const config = () => ({ origin, tenant: 'TenantA', bearerToken, caFile: tls.cert_path });

describe('gateway HTTPS reader', () => {
  it('uses only fixed GET routes, server-supplied auth and projected output', async () => {
    respond = (request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(request.url === '/v3/status' ? { version: '3.0', presence: [], queued: 999 } : { items: [] }));
    };
    const reader = await createGatewayReader(config());
    expect(await reader.status()).toEqual({ tenant_id: 'TenantA', version: '3.0', online: 0, presence: { items: [], total: 0, truncated: false } });
    expect(await reader.agents()).toEqual({ tenant_id: 'TenantA', items: [], total: 0, truncated: false });
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/v3/status' }, { method: 'GET', path: '/v3/console/agents' },
    ]);
    for (const request of requests) {
      expect(request.headers.authorization).toBe(`Bearer ${bearerToken}`);
      expect(request.headers['x-cauce-tenant']).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
    }
  });

  it('authenticates using supplied mTLS material without an upstream bearer', async () => {
    respond = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}'); };
    const reader = await createGatewayReader({ origin, tenant: 'TenantA', caFile: tls.cert_path, certificateFile: tls.cert_path, keyFile: tls.key_path });
    await reader.agents();
    expect(requests[0]?.authorized).toBe(true);
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it('rejects an untrusted HTTPS certificate without weakening verification', async () => {
    const reader = await createGatewayReader({ origin, tenant: 'TenantA', bearerToken });
    await expect(reader.agents()).rejects.toThrow('gateway_unavailable');
    expect(requests).toHaveLength(0);
  });

  it.each([[401, 'gateway_unauthorized'], [403, 'gateway_forbidden'], [500, 'gateway_unavailable'], [302, 'gateway_unavailable']] as const)(
    'maps HTTP %i to a stable error without disclosing upstream body or following redirects', async (status, error) => {
      respond = (_request, response) => response.writeHead(status, { location: `${origin}/private`, 'content-type': 'application/json' }).end('private secret');
      const reader = await createGatewayReader(config());
      await expect(reader.status()).rejects.toThrow(error);
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    ['text/html', undefined, '<html>secret</html>'],
    ['application/json', undefined, 'not json: secret'],
    ['application/json', 'gzip', '{"items":[]}'],
    ['application/json', undefined, '{"items":[{"tenant_id":"TenantA"}]}'],
  ])('rejects malformed content %#', async (contentType, encoding, body) => {
    respond = (_request, response) => {
      response.setHeader('content-type', contentType);
      if (encoding) response.setHeader('content-encoding', encoding);
      response.end(body);
    };
    await expect((await createGatewayReader(config())).agents()).rejects.toThrow('gateway_response_invalid');
  });

  it('bounds streamed response bytes even without a content length', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(' '.repeat(MAX_GATEWAY_BYTES));
      response.end('x');
    };
    await expect((await createGatewayReader(config())).status()).rejects.toThrow('gateway_response_too_large');
  });

  it('rejects protocol upgrades immediately rather than leaving an unresolved read', async () => {
    respond = (_request, response) => {
      response.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' });
      response.end();
    };
    await expect((await createGatewayReader(config())).status()).rejects.toThrow('gateway_unavailable');
  }, 2000);

  it('times out the entire body even after headers and an initial chunk arrive', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    };
    await expect((await createGatewayReader(config())).status()).rejects.toThrow('gateway_timeout');
  }, 8000);

  it('redacts TLS file failure paths', async () => {
    await expect(createGatewayReader({ ...config(), caFile: '/not-present/private-secret.pem' })).rejects.toThrow('Gateway TLS files could not be loaded');
  });
});
