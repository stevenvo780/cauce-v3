import { request, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayHttpServer, MAX_MCP_REQUEST_BYTES, MAX_MCP_REQUESTS } from './gateway-http.js';
import { GatewayReadError, projectGatewayAgents, projectGatewayStatus } from './gateway-projection.js';
import { createGatewayAuthorization, MCP_METADATA_PATH, type GatewayAuthorization } from './gateway-authorization.js';

const accessToken = 'mcp-fixture-token-not-a-real-secret-0000';
const publicOrigin = 'https://mcp.example';
const status = vi.fn(async () => projectGatewayStatus({ version: '3.0', presence: [] }, 'TenantA'));
const agents = vi.fn(async () => projectGatewayAgents({ items: [] }, 'TenantA'));
const headers = {
  host: 'mcp.example', authorization: `Bearer ${accessToken}`,
  accept: 'application/json, text/event-stream', 'content-type': 'application/json',
};
let http: Server;
let endpoint: URL;
const clients: Client[] = [];

async function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new Error('fixture requires a string body');
  return new Promise((resolve, reject) => {
    const requestHeaders: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { requestHeaders[name] = value; });
    const req = request(url, { method: init.method ?? 'GET', headers: requestHeaders }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: response.statusCode ?? 500, headers: responseHeaders }));
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

async function startServer(authorization: GatewayAuthorization = createGatewayAuthorization(publicOrigin, { mode: 'static', accessToken })) {
  http = createGatewayHttpServer({ reader: { status, agents }, authorization, publicOrigin });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing test listener');
  endpoint = new URL(`http://127.0.0.1:${String(address.port)}/mcp`);
}

beforeEach(async () => {
  status.mockClear(); agents.mockClear();
  await startServer();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => { await client.close(); }));
  http.closeAllConnections();
  await new Promise<void>((resolve, reject) => http.close((error) => { if (error) reject(error); else resolve(); }));
  vi.unstubAllGlobals();
});

async function client(): Promise<Client> {
  const connection = new Client({ name: 'gateway-bridge-test', version: '1.0.0' });
  clients.push(connection);
  await connection.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers }, fetch }) as Transport);
  return connection;
}

function rpc(method: string, params: unknown = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
}

describe('gateway Streamable HTTP endpoint', () => {
  it('completes the real SDK handshake, ping, listing and both read-only calls', async () => {
    const connection = await client();
    await connection.ping();
    const listed = await connection.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['cauce_status', 'cauce_agents']);
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(await connection.callTool({ name: 'cauce_status', arguments: {} })).toEqual({
      content: [{ type: 'text', text: JSON.stringify(projectGatewayStatus({ version: '3.0', presence: [] }, 'TenantA')) }],
    });
    const result = await connection.callTool({ name: 'cauce_agents' });
    expect(result.isError).not.toBe(true);
    expect(status).toHaveBeenCalledOnce();
    expect(agents).toHaveBeenCalledOnce();
  });

  it('accepts notifications and stateless concurrent clients without shared sessions', async () => {
    const [first, second] = await Promise.all([client(), client()]);
    await Promise.all([first.callTool({ name: 'cauce_agents' }), second.callTool({ name: 'cauce_status' })]);
    const notification = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(notification.status).toBe(202);
    expect(notification.headers.get('mcp-session-id')).toBeNull();
    expect(agents).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
  });

  it.each(['POST', 'GET', 'DELETE'])('requires independent authorization for %s', async (method) => {
    const response = await fetch(endpoint, { method, headers: { ...headers, authorization: 'Bearer gateway-fixture-token' }, ...(method === 'POST' ? { body: rpc('tools/list') } : {}) });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(status).not.toHaveBeenCalled(); expect(agents).not.toHaveBeenCalled();
  });

  it.each([
    { host: 'evil.example' }, { origin: 'https://evil.example' }, { origin: 'null' },
  ])('rejects invalid Host or Origin %# before dispatch', async (override) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { ...headers, ...override }, body: rpc('tools/list') });
    expect(response.status).toBe(403);
  });

  it('allows only the configured origin and exact endpoint', async () => {
    const good = await fetch(endpoint, { method: 'POST', headers: { ...headers, origin: publicOrigin }, body: rpc('tools/list') });
    expect(good.status).toBe(200);
    for (const suffix of ['?token=anything', '/other']) {
      expect((await fetch(`${endpoint.toString()}${suffix}`, { method: 'POST', headers, body: rpc('tools/list') })).status).toBe(404);
    }
    expect((await fetch(endpoint, { headers })).status).toBe(405);
    expect((await fetch(endpoint, { method: 'DELETE', headers })).status).toBe(405);
  });

  it.each([
    { tenant: 'Other' }, { alias: 'other' }, { url: 'https://evil.example' },
    { method: 'POST' }, { token: 'secret' }, { limit: 10000 }, { headers: { 'x-cauce-tenant': 'Other' } },
  ])('rejects every unexpected tool argument without upstream traffic %#', async (args) => {
    const connection = await client();
    const result = await connection.callTool({ name: 'cauce_agents', arguments: args });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'invalid_arguments' }] });
    expect(agents).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });

  it('rejects unknown tools without reflecting attacker-controlled names', async () => {
    const result = await (await client()).callTool({ name: 'write_secret_UNTRUSTED' });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'unknown_tool' }] });
    expect(agents).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });

  it('returns stable tool errors without exposing exception text', async () => {
    const connection = await client();
    status.mockRejectedValueOnce(new Error('secret token: sensitive'));
    expect(await connection.callTool({ name: 'cauce_status' })).toEqual({ isError: true, content: [{ type: 'text', text: 'gateway_unavailable' }] });
    agents.mockRejectedValueOnce(new GatewayReadError('gateway_forbidden'));
    expect(await connection.callTool({ name: 'cauce_agents' })).toEqual({ isError: true, content: [{ type: 'text', text: 'gateway_forbidden' }] });
  });

  it.each(['{', 'null', '[]', '[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cauce_agents"}}]'])(
    'rejects malformed or batch input before dispatch: %s', async (body) => {
      expect((await fetch(endpoint, { method: 'POST', headers, body })).status).toBe(400);
      expect(agents).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized input, wrong content type and unsupported protocol', async () => {
    expect((await fetch(endpoint, { method: 'POST', headers, body: ' '.repeat(MAX_MCP_REQUEST_BYTES + 1) })).status).toBe(413);
    expect((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: rpc('tools/list') })).status).toBe(415);
    expect((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': 'unsupported' }, body: rpc('tools/list') })).status).toBe(400);
    expect(agents).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });

  it('limits active requests and rejects excess work without dispatch', async () => {
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    status.mockImplementation(async () => { await hold; return projectGatewayStatus({ version: '3.0', presence: [] }, 'TenantA'); });
    try {
      const pending = Array.from({ length: MAX_MCP_REQUESTS }, async () => fetch(endpoint, {
        method: 'POST', headers, body: rpc('tools/call', { name: 'cauce_status' }),
      }));
      await vi.waitFor(() => { expect(status).toHaveBeenCalledTimes(MAX_MCP_REQUESTS); });
      expect((await fetch(endpoint, { method: 'POST', headers, body: rpc('tools/call', { name: 'cauce_status' }) })).status).toBe(503);
      release?.();
      expect((await Promise.all(pending)).every((response) => response.status === 200)).toBe(true);
    } finally {
      release?.();
      status.mockImplementation(async () => projectGatewayStatus({ version: '3.0', presence: [] }, 'TenantA'));
    }
  });

  it('serves OAuth discovery, verifies a real JWT and advertises tool security schemes', async () => {
    await new Promise<void>((resolve) => http.close(() => { resolve(); }));
    const keys = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(keys.publicKey), kid: 'http-fixture', alg: 'RS256', use: 'sig' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))));
    const oauth = { mode: 'oauth', issuer: 'https://issuer.example', jwksUri: 'https://issuer.example/jwks', subject: 'owner' } as const;
    await startServer(createGatewayAuthorization(publicOrigin, oauth));
    const metadata = await fetch(new URL(MCP_METADATA_PATH, endpoint), { headers: { host: headers.host } });
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: `${publicOrigin}/mcp`, authorization_servers: [oauth.issuer] });
    const wrongMethod = await fetch(new URL(MCP_METADATA_PATH, endpoint), { method: 'POST', headers, body: '{}' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
    const denied = await fetch(endpoint, { method: 'POST', headers: { ...headers, authorization: '' }, body: rpc('tools/list') });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain(`${publicOrigin}${MCP_METADATA_PATH}`);
    const jwt = await new SignJWT({ scope: 'cauce.read' }).setProtectedHeader({ alg: 'RS256', kid: 'http-fixture', typ: 'at+jwt' })
      .setIssuer(oauth.issuer).setAudience(`${publicOrigin}/mcp`).setSubject(oauth.subject).setExpirationTime('1m').sign(keys.privateKey);
    const connection = new Client({ name: 'oauth-http-test', version: '1.0.0' });
    clients.push(connection);
    await connection.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { ...headers, authorization: `Bearer ${jwt}` } }, fetch,
    }) as Transport);
    const listed = await connection.listTools();
    expect(listed.tools.every((tool) => JSON.stringify(tool._meta?.securitySchemes) === JSON.stringify([{ type: 'oauth2', scopes: ['cauce.read'] }]))).toBe(true);
    expect((await connection.callTool({ name: 'cauce_agents' })).isError).not.toBe(true);
    expect(agents).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('includes pending authentication in the active request bound', async () => {
    await new Promise<void>((resolve) => http.close(() => { resolve(); }));
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const authenticate = vi.fn(async () => { await hold; return false; });
    await startServer({ ...createGatewayAuthorization(publicOrigin, { mode: 'static', accessToken }), authenticate });
    const pending = Array.from({ length: MAX_MCP_REQUESTS }, async () => fetch(endpoint, { method: 'POST', headers, body: rpc('tools/list') }));
    try {
      await vi.waitFor(() => { expect(authenticate).toHaveBeenCalledTimes(MAX_MCP_REQUESTS); });
      expect((await fetch(endpoint, { method: 'POST', headers, body: rpc('tools/list') })).status).toBe(503);
    } finally { release?.(); }
    expect((await Promise.all(pending)).every((response) => response.status === 401)).toBe(true);
    expect(agents).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });
});
