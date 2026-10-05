import { IncomingMessage, request as httpRequest, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayHttpHandler, type GatewayHttpHandler, type GatewayHttpOptions } from '@cauce/mcp-fleet-monitor/gateway-http';
import { registerMcpIngress } from './mcp-ingress.js';

const handedOff = vi.hoisted(() => vi.fn<(request: IncomingMessage, response: ServerResponse) => void>());
const drainStarted = vi.hoisted(() => vi.fn<() => void>());
vi.mock('@cauce/mcp-fleet-monitor/gateway-http', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cauce/mcp-fleet-monitor/gateway-http')>();
  return {
    ...original,
    createGatewayHttpHandler: vi.fn((options: GatewayHttpOptions) => {
      const handler = original.createGatewayHttpHandler(options);
      const wrapped: GatewayHttpHandler = (request: IncomingMessage, response: ServerResponse) => {
        handedOff(request, response);
        handler(request, response);
      };
      wrapped.drain = () => { drainStarted(); return handler.drain(); };
      return wrapped;
    }),
  };
});

const publicOrigin = 'https://mcp.example';
const metadataPath = '/.well-known/oauth-protected-resource/mcp';
const headers = {
  host: 'mcp.example', authorization: 'Bearer fixture-alice',
  accept: 'application/json, text/event-stream', 'content-type': 'application/json',
};
const rpc = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
type HumanOptions = Extract<GatewayHttpOptions, { operationsFactory: unknown }>;

function humanOptions() {
  return {
    publicOrigin,
    authorization: {
      mode: 'oauth',
      challenge: `Bearer resource_metadata="${publicOrigin}${metadataPath}"`,
      metadata: {
        resource: `${publicOrigin}/mcp`, authorization_servers: ['https://issuer.example'],
        scopes_supported: ['cauce.read', 'cauce.publish'], bearer_methods_supported: ['header'], resource_name: 'Cauce MCP',
      },
      authenticateIdentity: vi.fn(async (header: string) => {
        if (header !== 'Bearer fixture-alice' && header !== 'Bearer fixture-bob') return undefined;
        return Object.freeze({
          kind: 'oauth' as const, issuer: 'https://issuer.example', subject: header.slice(15),
          audience: `${publicOrigin}/mcp`, expiresAt: Date.now() / 1000 + 60,
          scopes: Object.freeze(['cauce.read']),
        });
      }),
    },
    operationsFactory: {
      forRequest: vi.fn<HumanOptions['operationsFactory']['forRequest']>(async () => ({
        status: async () => ({ version: '3.0', tenant_id: 'TenantA', online: 0, presence: { items: [], total: 0, truncated: false } }),
        agents: async () => ({ tenant_id: 'TenantA', items: [], total: 0, truncated: false }),
        submit: async () => { throw new Error('Fixture cannot publish'); },
        receipt: async () => { throw new Error('Fixture has no receipts'); },
        inbox: async () => { throw new Error('Fixture has no inbox'); },
      })),
    },
  } satisfies HumanOptions;
}

interface FixtureRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  payload?: string;
}
interface FixtureResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
  json(): unknown;
}

async function send(app: FastifyInstance, input: FixtureRequest | string): Promise<FixtureResponse> {
  const options = typeof input === 'string' ? { url: input } : input;
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const requestHeaders = { ...options.headers };
  if (options.payload !== undefined && ['GET', 'OPTIONS'].includes(options.method ?? 'GET')) {
    requestHeaders['content-length'] = String(Buffer.byteLength(options.payload));
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: address.port, path: options.url,
      method: options.method ?? 'GET', headers: requestHeaders,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode ?? 500, headers: response.headers, body, json: () => JSON.parse(body) as unknown });
      });
    });
    request.on('error', reject);
    request.end(options.payload);
  });
}

describe('MCP ingress over native HTTP on the Fastify listener', () => {
  const apps: FastifyInstance[] = [];
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(async () => { await Promise.all(apps.splice(0).map(async (app) => app.close())); });

  async function mount(options: GatewayHttpOptions = humanOptions(), configure?: (app: FastifyInstance) => void) {
    const app = Fastify({ logger: false });
    apps.push(app);
    configure?.(app);
    await app.register(registerMcpIngress, options);
    await app.listen({ port: 0, host: '127.0.0.1' });
    return app;
  }

  it('hands the same untouched raw stream and response to one handler before parsing', async () => {
    const seen: { request?: IncomingMessage; response?: ServerResponse } = {};
    const chunks: Buffer[] = [];
    const preParsing = vi.fn();
    const parser = vi.fn();
    const fallback = vi.fn();
    const app = await mount(humanOptions(), (instance) => {
      instance.addHook('onRequest', async (request, reply) => {
        seen.request = request.raw; seen.response = reply.raw;
        expect(request.raw).toBeInstanceOf(IncomingMessage);
        expect(request.body).toBeUndefined();
        const iterate = request.raw[Symbol.asyncIterator].bind(request.raw);
        request.raw[Symbol.asyncIterator] = async function* (): AsyncGenerator<Buffer | string, undefined> {
          const stream: AsyncIterable<unknown> = { [Symbol.asyncIterator]: iterate };
          for await (const chunk of stream) {
            if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') throw new Error('Unexpected fixture chunk');
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            yield chunk;
          }
          return undefined;
        };
      });
      instance.addHook('preParsing', async (_request, _reply, payload) => { preParsing(); return payload; });
      instance.removeContentTypeParser('application/json');
      instance.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, _body, done) => {
        parser(); done(new Error('Fastify parser must not run'));
      });
      instance.addHook('preHandler', async () => { fallback(); });
    });
    const body = '{\n  "jsonrpc": "2.0", "id": "á漢", "method": "tools/list"\n}';
    const response = await send(app, { method: 'POST', url: '/mcp', headers, payload: body });
    expect(response.statusCode).toBe(200);
    const bodyResult = response.json() as { id: string; result: { tools: unknown[] } };
    expect(bodyResult.id).toBe('á漢'); expect(bodyResult.result.tools).toBeInstanceOf(Array);
    expect(Buffer.concat(chunks).toString('utf8')).toBe(body);
    expect(handedOff).toHaveBeenCalledExactlyOnceWith(seen.request, seen.response);
    expect(createGatewayHttpHandler).toHaveBeenCalledOnce();
    expect(preParsing).not.toHaveBeenCalled(); expect(parser).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });

  it('serves metadata without authentication or resolving human operations', async () => {
    const options = humanOptions();
    const app = await mount(options);
    const response = await send(app, { url: metadataPath, headers: { host: headers.host } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(options.authorization.metadata);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(options.authorization.authenticateIdentity).not.toHaveBeenCalled();
    expect(options.operationsFactory.forRequest).not.toHaveBeenCalled();
    const wrongMethod = await send(app, { method: 'POST', url: metadataPath, headers, payload: '{' });
    expect(wrongMethod.statusCode).toBe(405); expect(wrongMethod.headers.allow).toBe('GET');
  });

  it('serves public metadata to browser clients with credential-free CORS without relaxing /mcp', async () => {
    const options = humanOptions();
    const app = await mount(options);
    const foreign = { host: headers.host, origin: 'https://inspector.example' };
    const preflight = await send(app, { method: 'OPTIONS', url: metadataPath, headers: { ...foreign, 'access-control-request-method': 'GET' } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    const response = await send(app, { url: metadataPath, headers: foreign });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(options.authorization.metadata);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect((await send(app, { url: metadataPath, headers: { host: headers.host } })).headers['access-control-allow-origin']).toBe('*');
    expect((await send(app, { url: metadataPath, headers: { ...foreign, host: 'other.example' } })).statusCode).toBe(403);
    const mcp = await send(app, { method: 'POST', url: '/mcp', headers: { ...headers, origin: 'https://inspector.example' }, payload: rpc('tools/list') });
    expect(mcp.statusCode).toBe(403);
    expect(mcp.headers['access-control-allow-origin']).toBeUndefined();
    expect(options.authorization.authenticateIdentity).not.toHaveBeenCalled();
  });

  it('authorizes before JSON, media-type and method handling without accepting cookies as bearer', async () => {
    const options = humanOptions();
    const app = await mount(options);
    for (const method of ['POST', 'GET', 'OPTIONS'] as const) {
      const response = await send(app, {
        method, url: '/mcp', headers: { host: headers.host, cookie: 'session=fixture', 'x-cauce-operator': 'fixture' }, payload: '{',
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe(options.authorization.challenge);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ error: 'unauthorized' });
    }
    expect(options.operationsFactory.forRequest).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const)('keeps authenticated %s method policy in the handler', async (method) => {
    const app = await mount();
    const response = await send(app, { method, url: '/mcp', headers });
    expect(response.statusCode).toBe(405); expect(response.headers.allow).toBe('POST');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['/mcp?x=1', `${metadataPath}?x=1`, '/mcp/', `${metadataPath}/`, '/mcp/other'])(
    'does not widen strict path acceptance for %s', async (url) => {
      const options = humanOptions();
      const app = await mount(options);
      expect((await send(app, { method: 'POST', url, headers, payload: rpc('tools/list') })).statusCode).toBe(404);
      expect(options.authorization.authenticateIdentity).not.toHaveBeenCalled();
      expect(options.operationsFactory.forRequest).not.toHaveBeenCalled();
      if (url.includes('?')) expect(handedOff.mock.calls[0]?.[0].url).toBe(url);
      else expect(handedOff).not.toHaveBeenCalled();
    },
  );

  it.each([{ host: 'other.example' }, { origin: 'https://other.example' }, { origin: 'null' }])('preserves Host and Origin validation %#', async (override) => {
    const options = humanOptions();
    const app = await mount(options);
    const response = await send(app, { method: 'POST', url: '/mcp', headers: { ...headers, ...override }, payload: rpc('tools/list') });
    expect(response.statusCode).toBe(403);
    expect(options.authorization.authenticateIdentity).not.toHaveBeenCalled();
  });

  it.each([
    { payload: '{', extra: {}, status: 400 },
    { payload: 'null', extra: {}, status: 400 },
    { payload: '[]', extra: {}, status: 400 },
    { payload: '{}', extra: { 'content-type': 'text/plain' }, status: 415 },
    { payload: '{}', extra: { 'content-encoding': 'gzip' }, status: 415 },
    { payload: ' '.repeat(16 * 1024 + 1), extra: {}, status: 413 },
  ])('keeps handler body rejection %# instead of Fastify errors', async ({ payload, extra, status }) => {
    const app = await mount();
    const response = await send(app, { method: 'POST', url: '/mcp', headers: { ...headers, ...extra }, payload });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: 'request_rejected' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('accepts the handler byte limit despite a smaller Fastify body limit', async () => {
    const body = rpc('tools/list');
    const payload = body + ' '.repeat(16 * 1024 - Buffer.byteLength(body));
    const app = Fastify({ bodyLimit: 8 }); apps.push(app);
    await app.register(registerMcpIngress, humanOptions());
    await app.listen({ port: 0, host: '127.0.0.1' });
    expect((await send(app, { method: 'POST', url: '/mcp', headers, payload })).statusCode).toBe(200);
  });

  it('keeps discovery lazy and separates concurrent per-request identities and signals', async () => {
    const options = humanOptions(); const app = await mount(options);
    expect((await send(app, { method: 'POST', url: '/mcp', headers, payload: rpc('tools/list') })).statusCode).toBe(200);
    expect(options.operationsFactory.forRequest).not.toHaveBeenCalled();
    const responses = await Promise.all(['alice', 'bob'].map(async (subject) => send(app, {
      method: 'POST', url: '/mcp', headers: { ...headers, authorization: `Bearer fixture-${subject}` },
      payload: rpc('tools/call', { name: 'cauce_agents' }),
    })));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const calls = vi.mocked(options.operationsFactory.forRequest).mock.calls;
    expect(calls.map(([identity]) => identity.subject).sort()).toEqual(['alice', 'bob']);
    expect(calls[0]?.[1]).not.toBe(calls[1]?.[1]);
    expect(calls.every(([, signal]) => signal.aborted)).toBe(true);
    expect(createGatewayHttpHandler).toHaveBeenCalledOnce();
  });

  it('leaves scope checks with the handler before resolving request operations', async () => {
    const options = humanOptions();
    const identity = await options.authorization.authenticateIdentity(headers.authorization);
    if (!identity) throw new Error('Missing fixture identity');
    options.authorization.authenticateIdentity.mockResolvedValue({ ...identity, scopes: [] });
    const app = await mount(options);
    const response = await send(app, { method: 'POST', url: '/mcp', headers, payload: rpc('tools/call', { name: 'cauce_agents' }) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: 'forbidden' }] } });
    expect(options.operationsFactory.forRequest).not.toHaveBeenCalled();
  });

  it('shares eight pending authentication slots per app and recovers them', async () => {
    const options = humanOptions();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const authenticate = options.authorization.authenticateIdentity;
    options.authorization.authenticateIdentity = vi.fn(async (header: string) => { await hold; return authenticate(header); });
    const app = await mount(options);
    const request = { method: 'POST' as const, url: '/mcp', headers, payload: rpc('tools/list') };
    const pending = Array.from({ length: 8 }, async () => send(app, request));
    try {
      await vi.waitFor(() => { expect(options.authorization.authenticateIdentity).toHaveBeenCalledTimes(8); });
      expect((await send(app, request)).statusCode).toBe(503);
      const second = await mount();
      expect((await send(second, request)).statusCode).toBe(200);
    } finally { release?.(); }
    expect((await Promise.all(pending)).every((response) => response.statusCode === 200)).toBe(true);
    expect((await send(app, request)).statusCode).toBe(200);
  });

  it('waits for request cleanup during app.close before closing the listener', async () => {
    const options = humanOptions();
    let releaseCleanup: (() => void) | undefined;
    const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupFinished = false;
    let operationSignal: AbortSignal | undefined;
    options.operationsFactory.forRequest = vi.fn(async (_identity, signal) => {
      operationSignal = signal;
      await new Promise<void>((resolve) => { signal.addEventListener('abort', async () => {
        await cleanupBarrier;
        cleanupFinished = true;
        resolve();
      }, { once: true }); });
      return {
        status: async () => ({ version: '3.0', tenant_id: 'TenantA', online: 0, presence: { items: [], total: 0, truncated: false } }),
        agents: async () => ({ tenant_id: 'TenantA', items: [], total: 0, truncated: false }),
        submit: async () => { throw new Error('Fixture cannot publish'); },
        receipt: async () => { throw new Error('Fixture has no receipts'); },
        inbox: async () => { throw new Error('Fixture has no inbox'); },
      };
    });
    const app = await mount(options);
    const pending = send(app, { method: 'POST', url: '/mcp', headers, payload: rpc('tools/call', { name: 'cauce_status' }) }).catch(() => undefined);
    try {
      await vi.waitFor(() => { expect(options.operationsFactory.forRequest).toHaveBeenCalledOnce(); });
      let closed = false;
      const closing = app.close().then(() => { closed = true; });
      await vi.waitFor(() => { expect(drainStarted).toHaveBeenCalledOnce(); });
      await vi.waitFor(() => { expect(operationSignal?.aborted).toBe(true); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      expect(cleanupFinished).toBe(false);
      releaseCleanup?.();
      await closing;
      expect(cleanupFinished).toBe(true);
      await pending;
    } finally {
      releaseCleanup?.();
      if (app.server.listening) await app.close();
    }
  });

  it('does not interrupt an unrelated Fastify route while draining MCP', async () => {
    let markStarted: (() => void) | undefined;
    const routeStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const app = await mount(humanOptions(), (instance) => {
      instance.get('/health-delayed', async () => {
        markStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { status: 'ok' };
      });
    });
    const health = send(app, { url: '/health-delayed', headers: { connection: 'close' } });
    await routeStarted;
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    const response = await health;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await closing;
    expect(closed).toBe(true);
  });

  it('returns a safe error without leaking authorization failures', async () => {
    const options = humanOptions();
    options.authorization.authenticateIdentity = vi.fn(async () => { throw new Error('private fixture detail'); });
    const app = await mount(options);
    const response = await send(app, { method: 'POST', url: '/mcp', headers, payload: rpc('tools/list') });
    expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: 'request_rejected' });
    expect(response.body).not.toContain('private fixture detail');
  });

  it('leaves unrelated routes and their JSON lifecycle with Fastify', async () => {
    const parser = vi.fn();
    const app = await mount(humanOptions(), (instance) => {
      instance.addHook('preHandler', async () => { parser(); });
      instance.get('/health', async () => ({ status: 'ok' }));
      instance.post('/v3/fixture', async (request, reply) => {
        if (request.headers.authorization !== 'Bearer technical-fixture') return reply.code(401).send({ error: 'unauthorized' });
        return request.body;
      });
    });
    expect((await send(app, '/health')).json()).toEqual({ status: 'ok' });
    expect((await send(app, { method: 'POST', url: '/v3/fixture', headers, payload: '{}' })).statusCode).toBe(401);
    const response = await send(app, { method: 'POST', url: '/v3/fixture', headers: { ...headers, authorization: 'Bearer technical-fixture' }, payload: '{"value":1}' });
    expect(response.json()).toEqual({ value: 1 });
    expect(parser).toHaveBeenCalledTimes(3); expect(handedOff).not.toHaveBeenCalled();
  });
});


describe('MCP ingress without a socket', () => {
  it('registers only the two paths and serves metadata through raw hijack', async () => {
    vi.clearAllMocks();
    const app = Fastify();
    const options = humanOptions();
    try {
      await app.register(registerMcpIngress, options);
      const response = await app.inject({ url: metadataPath, headers: { host: headers.host } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(options.authorization.metadata);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(options.authorization.authenticateIdentity).not.toHaveBeenCalled();
      expect(options.operationsFactory.forRequest).not.toHaveBeenCalled();
      expect(createGatewayHttpHandler).toHaveBeenCalledOnce();
      expect(app.hasRoute({ method: 'POST', url: '/mcp' })).toBe(true);
      expect(app.hasRoute({ method: 'GET', url: '/mcp/' })).toBe(false);
      expect(app.hasRoute({ method: 'GET', url: '/mcp/other' })).toBe(false);
      expect(app.server.listening).toBe(false);
    } finally { await app.close(); }
  });
});
