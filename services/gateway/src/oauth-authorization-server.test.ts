import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { buildTestGateway } from './test-support/gateway-doubles.js';
import { describe, expect, it, vi } from 'vitest';
import { OAuthClients, type OAuthClientMetadata } from './oauth-client-metadata.js';
import { OAuthRegistrationLimiter } from './oauth-client-registration.js';
import { OAuthTokens } from './oauth-tokens.js';
import { registerOAuthAuthorizationServer } from './oauth-authorization-server.js';
import { OAuthError, type OAuthAuthorizationRequest, type OAuthStore } from './oauth-authorization-types.js';
import { configuredHumanMcp } from './mcp-configuration.js';

const issuer = 'https://cauce.example';
const clientId = 'https://client.example/doc';
const redirectUri = 'https://client.example/callback';
const userId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';
const code = 'z'.repeat(43);
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const session = { userId, credentialStamp: 's'.repeat(43), issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt: Math.floor(Date.now() / 1000) + 3600, csrf: 'c'.repeat(43) };

async function fixture(authenticated = true, registrationLimiter?: OAuthRegistrationLimiter) {
  const app = Fastify();
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokens = new OAuthTokens({ issuer, resource: `${issuer}/mcp`, signingKey: privateKey, kid: 'fixture' });
  let pending: OAuthAuthorizationRequest | undefined;
  const consent = vi.fn<OAuthStore['consent']>(async (_id, _browser, _session, selected) => {
    if (!pending) throw new OAuthError('invalid_request');
    return { request: pending, ...(selected === undefined ? {} : { code }) };
  });
  const exchange = vi.fn<OAuthStore['exchange']>(async (input, issue) => {
    if (input.challenge !== challenge) throw new OAuthError('invalid_grant');
    return issue({ grantId, userId, scopes: ['cauce.read'], expiresAt: session.expiresAt });
  });
  const registry = new Map<string, OAuthClientMetadata>();
  const store: OAuthStore = { createRequest: async (value) => { pending = value; },
    request: async (id, browser) => pending?.idHash === id && pending.browserHash === browser ? pending : undefined,
    consent, exchange, validate: async () => true, grants: async () => [], revoke: vi.fn(async () => undefined),
    registerClient: async (registration) => {
      const registered = { ...registration, clientId: `cauce-dcr-${randomUUID()}`, issuedAt: Math.floor(Date.now() / 1000) };
      registry.set(registered.clientId, { clientId: registered.clientId, clientName: registration.clientName ?? 'Cliente MCP sin nombre',
        redirectUris: registration.redirectUris });
      return registered;
    },
    registeredClient: async (id) => registry.get(id) };
  const clients = new OAuthClients({ fetch: async () => ({ body: JSON.stringify({ client_id: clientId,
    client_name: '<script>unsafe</script>', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) }) });
  const login = vi.fn(async (_request, reply: Parameters<import('./password-auth.js').PasswordAuthProvider['login']>[1]) => { await reply.code(200).send({ authenticated: true }); });
  await registerOAuthAuthorizationServer(app, { clients, tokens, store, passwordAuth: { login, verifyCredentialStamp: () => false },
    ...(registrationLimiter === undefined ? {} : { registrationLimiter }),
    session: async () => { if (!authenticated) throw new OAuthError('access_denied'); return session; } });
  const authorize = (override: Record<string, string> = {}) => `/oauth/authorize?${new URLSearchParams({ response_type: 'code',
    client_id: clientId, redirect_uri: redirectUri, resource: tokens.resource, scope: 'cauce.read cauce.publish',
    state: 'fixture-state', code_challenge: challenge, code_challenge_method: 'S256', ...override })}`;
  async function start() {
    const response = await app.inject({ method: 'GET', url: authorize() });
    const id = /request_id=([A-Za-z0-9_-]{43})/u.exec(response.body)?.[1] ?? '';
    return { response, id, cookie: String(response.headers['set-cookie']).split(';')[0] ?? '' };
  }
  return { app, tokens, store, consent, exchange, login, authorize, start };
}

describe('OAuth HTTP protocol with injected store, without PostgreSQL', () => {
  it('connects explicit local mode to local verification with exact issuer and resource', async () => {
    const f = await fixture();
    try {
      const options = { tokens: f.tokens, store: f.store, clients: new OAuthClients(), passwordAuth: { login: f.login, verifyCredentialStamp: () => false }, session: async () => session };
      const environment = { CAUCE_MCP_OAUTH_PROVIDER: 'local', CAUCE_MCP_PUBLIC_ORIGIN: issuer };
      const configured = configuredHumanMcp(environment, options);
      const issued = f.tokens.issue({ grantId, userId, scopes: ['cauce.read'], expiresAt: session.expiresAt });
      expect(await configured?.authorization.authenticateIdentity(`Bearer ${issued.token}`)).toEqual(issued.identity);
      expect(() => configuredHumanMcp({ ...environment, CAUCE_MCP_PUBLIC_ORIGIN: 'https://other.example' }, options)).toThrow();
      expect(() => configuredHumanMcp(environment)).toThrow();
      expect(() => configuredHumanMcp({ ...environment, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, options)).toThrow();
    } finally { await f.app.close(); }
  });
  it('advertises PKCE S256, no refresh and a public JWKS', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject('/.well-known/oauth-authorization-server');
      expect(response.json()).toMatchObject({ issuer, grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'] });
      expect(response.json()).toMatchObject({ registration_endpoint: `${issuer}/oauth/register` });
      expect((await f.app.inject('/oauth/jwks')).body).not.toContain('"d":');
    } finally { await f.app.close(); }
  });
  it.each([{ resource: `${issuer}/other` }, { code_challenge_method: 'plain' },
    { redirect_uri: 'https://other.example/callback' }, { scope: 'cauce.admin' }])('rejects invalid authorization %j without redirecting', async (override) => {
    const f = await fixture();
    try {
      const response = await f.app.inject(f.authorize(override));
      expect(response.statusCode).toBe(400);
      expect(response.headers.location).toBeUndefined();
    } finally { await f.app.close(); }
  });
  it('escapes client metadata, keeps Strict cookies and requires same-origin continuation', async () => {
    const f = await fixture();
    try {
      const flow = await f.start();
      expect(flow.response.statusCode).toBe(200);
      expect(flow.response.body).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
      expect(flow.response.headers['set-cookie']).toContain('SameSite=Strict');
      expect(flow.response.headers['set-cookie']).toContain('HttpOnly');
      expect(flow.response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect((await f.app.inject({ url: `/oauth/continue?request_id=${flow.id}`, headers: { cookie: flow.cookie, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
      const response = await f.app.inject({ url: `/oauth/continue?request_id=${flow.id}`, headers: { cookie: flow.cookie, 'sec-fetch-site': 'same-origin' } });
      expect(response.body).toContain('name="read"');
      expect(response.body).toContain('name="publish"');
      expect(response.body).not.toContain(' checked');
    } finally { await f.app.close(); }
  });
  it('offers password login when the human session is absent', async () => {
    const f = await fixture(false);
    try {
      const flow = await f.start();
      const response = await f.app.inject({ url: `/oauth/continue?request_id=${flow.id}`, headers: { cookie: flow.cookie, 'sec-fetch-site': 'same-origin' } });
      expect(response.body).toContain('autocomplete="current-password"');
      expect(f.login).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('sends only selected consent and redirects with issuer, code and original state', async () => {
    const f = await fixture();
    try {
      const flow = await f.start();
      const response = await f.app.inject({ method: 'POST', url: '/oauth/consent', headers: { origin: issuer, cookie: flow.cookie,
        'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ request_id: flow.id, csrf: session.csrf, decision: 'approve', read: 'yes' }).toString() });
      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
      const location = new URL(response.json<{ redirect_uri: string }>().redirect_uri);
      expect(location.origin).toBe('https://client.example');
      expect(location.searchParams.get('state')).toBe('fixture-state');
      expect(location.searchParams.get('iss')).toBe(issuer);
      expect(location.searchParams.get('code')).toBe(code);
      expect(f.consent.mock.calls[0]?.[3]).toEqual(['cauce.read']);
    } finally { await f.app.close(); }
  });
  it.each(['https://evil.example', undefined])('rejects a missing or cross-origin consent origin %s', async (origin) => {
    const f = await fixture();
    try {
      const flow = await f.start();
      const response = await f.app.inject({ method: 'POST', url: '/oauth/consent', headers: { cookie: flow.cookie,
        ...(origin === undefined ? {} : { origin }) }, payload: { request_id: flow.id, csrf: session.csrf, decision: 'deny' } });
      expect(response.statusCode).toBe(403);
      expect(f.consent).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('rejects wrong CSRF and duplicate form parameters before consent', async () => {
    const f = await fixture();
    try {
      const flow = await f.start();
      const headers = { origin: issuer, cookie: flow.cookie, 'content-type': 'application/x-www-form-urlencoded' };
      const invalid = await f.app.inject({ method: 'POST', url: '/oauth/consent', headers,
        payload: new URLSearchParams({ request_id: flow.id, csrf: 'wrong', decision: 'deny' }).toString() });
      expect(invalid.statusCode).toBe(403);
      expect((await f.app.inject({ method: 'POST', url: '/oauth/consent', headers, payload: 'csrf=a&csrf=b' })).statusCode).toBe(400);
      expect(f.consent).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('exchanges with the actual ES256 signer and never returns a refresh token', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
          resource: f.tokens.resource, code, code_verifier: verifier }).toString() });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ access_token: string; token_type: string; scope: string }>();
      expect(f.tokens.verify(body.access_token)).toMatchObject({ subject: userId, grantId, scopes: ['cauce.read'] });
      expect(body).not.toHaveProperty('refresh_token');
    } finally { await f.app.close(); }
  });
  it('rejects a bearer used as client authentication and JSON token requests', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'POST', url: '/oauth/token', payload: {} })).statusCode).toBe(401);
      expect((await f.app.inject({ method: 'POST', url: '/oauth/token', headers: { authorization: 'Bearer fixture',
        'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=authorization_code' })).statusCode).toBe(401);
      expect(f.exchange).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
});


describe('OAuth dynamic registration and public CORS', () => {
  const register = (payload: unknown) => ({ method: 'POST' as const, url: '/oauth/register', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  it('registers a native public client and matches its loopback redirect on any port through code exchange', async () => {
    const f = await fixture();
    try {
      const created = await f.app.inject(register({ client_name: 'Claude\u202e Code\n  CLI', redirect_uris: ['http://127.0.0.1/callback', 'https://app.example/cb'],
        grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', logo_uri: 'https://ignored.example/logo.png' }));
      expect(created.statusCode).toBe(201);
      const client = created.json<{ client_id: string; client_name: string; token_endpoint_auth_method: string; grant_types: string[] }>();
      expect(client).toMatchObject({ client_name: 'Claude Code CLI', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
      expect(client.client_id).toMatch(/^cauce-dcr-[0-9a-f-]{36}$/u);
      expect(client).not.toHaveProperty('client_secret');
      expect(client).not.toHaveProperty('logo_uri');
      const native = 'http://127.0.0.1:49152/callback';
      const flow = await f.app.inject(f.authorize({ client_id: client.client_id, redirect_uri: native }));
      expect(flow.statusCode).toBe(200);
      for (const wrong of ['http://127.0.0.1:49152/other', 'http://localhost:49152/callback', 'http://evil.example:49152/callback']) {
        expect((await f.app.inject(f.authorize({ client_id: client.client_id, redirect_uri: wrong }))).statusCode).toBe(400);
      }
      const token = await f.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://inspector.example' },
        payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: native,
          resource: f.tokens.resource, code, code_verifier: verifier }).toString() });
      expect(token.statusCode).toBe(200);
      expect(token.headers['access-control-allow-origin']).toBe('*');
      expect(f.exchange.mock.calls[0]?.[0]).toMatchObject({ clientId: client.client_id, redirectUri: native });
      expect((await f.app.inject(f.authorize({ client_id: 'cauce-dcr-00000000-0000-4000-8000-000000000000', redirect_uri: native }))).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });
  it.each([
    [{ redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata'],
    [{ redirect_uris: ['https://app.example/cb'], grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
    [{ redirect_uris: ['https://app.example/cb'], response_types: ['token'] }, 'invalid_client_metadata'],
    [{ redirect_uris: ['http://app.example/cb'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://app.example/cb#frag'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://app.example/cb?state=x'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: Array.from({ length: 11 }, (_v, i) => `https://app.example/${String(i)}`) }, 'invalid_redirect_uri'],
    [{ redirect_uris: [] }, 'invalid_redirect_uri'],
    [{}, 'invalid_redirect_uri'],
  ])('rejects registration %j with %s', async (payload, error) => {
    const f = await fixture();
    try {
      const response = await f.app.inject(register(payload));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error });
    } finally { await f.app.close(); }
  });
  it('rate-limits registration per remote address with Retry-After', async () => {
    const f = await fixture(true, new OAuthRegistrationLimiter({ capacity: 1, refillMs: 60_000 }));
    try {
      expect((await f.app.inject(register({ redirect_uris: ['http://localhost/cb'] }))).statusCode).toBe(201);
      const limited = await f.app.inject(register({ redirect_uris: ['http://localhost/cb'] }));
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('60');
    } finally { await f.app.close(); }
  });
  it('answers CORS only on cookie-free public endpoints', async () => {
    const f = await fixture();
    try {
      for (const url of ['/.well-known/oauth-authorization-server', '/oauth/jwks', '/oauth/token', '/oauth/register']) {
        const preflight = await f.app.inject({ method: 'OPTIONS', url, headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' } });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe('*');
        expect(preflight.headers['access-control-allow-headers']).toContain('MCP-Protocol-Version');
        expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
      }
      expect((await f.app.inject('/.well-known/oauth-authorization-server')).headers['access-control-allow-origin']).toBe('*');
      const authorize = await f.app.inject(f.authorize());
      expect(authorize.headers['access-control-allow-origin']).toBeUndefined();
      for (const url of ['/oauth/authorize', '/oauth/continue', '/oauth/login', '/oauth/consent', '/oauth/grants']) {
        const response = await f.app.inject({ method: 'OPTIONS', url });
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    } finally { await f.app.close(); }
  });
});

describe('OAuth request logging', () => {
  it('preserves numeric and JSON logger interpolation when OAuth is disabled', async () => {
    let output = '';
    const stream = new Writable({ write(chunk: Buffer, _encoding, done) { output += chunk.toString(); done(); } });
    const app = await buildTestGateway({ logger: { stream } });
    app.get('/fixture-log', async (request) => {
      request.log.info('count=%d', 7);
      request.log.info('payload=%j', { count: 7 });
      return { ok: true };
    });
    try {
      const response = await app.inject('/fixture-log');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(output).toContain('count=7');
      expect(output).toContain('payload=');
      expect(output).toContain('count');
    } finally { await app.close(); }
  });
  it.each(['/o%61uth/no-such-route', '/%6fauth/no-such-route', '/oauth/no-such-route'])('redacts automatic 404 messages for the routed path %s', async (path) => {
      let output = '';
      const stream = new Writable({ write(chunk: Buffer, _encoding, done) { output += chunk.toString(); done(); } });
      const app = await buildTestGateway({ logger: { stream } });
      try {
        const response = await app.inject(`${path}?state=STATE_TEST_G&code=CODE_TEST_G`);
        expect(response.statusCode).toBe(404);
        expect(output).not.toContain('STATE_TEST_G');
        expect(output).not.toContain('CODE_TEST_G');
        expect(output).toContain('reqId');
        expect(output).toContain('GET');
        expect(output).toContain('no-such-route');
      } finally { await app.close(); }
    });
  it('keeps route, method and request IDs without logging opaque OAuth query values', async () => {
    let output = '';
    const stream = new Writable({ write(chunk: Buffer, _encoding, done) { output += chunk.toString(); done(); } });
    const app = await buildTestGateway({ logger: { stream } });
    try {
      await app.inject('/oauth/authorize?state=OAUTH_STATE_FIXTURE_7&code=OAUTH_CODE_FIXTURE_7&client_id=https%3A%2F%2Fclient.example%2Fprivate');
      expect(output).not.toContain('OAUTH_STATE_FIXTURE_7');
      expect(output).not.toContain('OAUTH_CODE_FIXTURE_7');
      expect(output).not.toContain('client.example');
      expect(output).toContain('/oauth/authorize');
      expect(output).toContain('GET');
      expect(output).toContain('reqId');
    } finally { await app.close(); }
  });
});


describe('OAuth HTTP context reaches durable mutations', () => {
  it('passes an abortable context into token exchange and aborts it on disconnect', async () => {
    const f = await fixture();
    let closeResponse: () => void = () => undefined;
    f.app.addHook('onRequest', async (_request, reply) => { closeResponse = () => { reply.raw.emit('close'); }; });
    f.exchange.mockImplementation(async (_input, _issue, context) => {
      expect(context.signal.aborted).toBe(false);
      expect(context.deadlineMs).toBeGreaterThan(Date.now());
      closeResponse();
      expect(context.signal.aborted).toBe(true);
      context.signal.throwIfAborted();
      throw new Error('unreachable');
    });
    try {
      const response = f.app.inject({ method: 'POST', url: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
          resource: f.tokens.resource, code, code_verifier: verifier }).toString() });
      await expect(response).rejects.toThrow('response destroyed before completion');
      expect(f.exchange).toHaveBeenCalledOnce();
    } finally { await f.app.close(); }
  });
  it('bounds the consent context by the verified session expiration', async () => {
    const f = await fixture();
    try {
      const flow = await f.start();
      await f.app.inject({ method: 'POST', url: '/oauth/consent', headers: { origin: issuer, cookie: flow.cookie },
        payload: { request_id: flow.id, csrf: session.csrf, decision: 'approve', read: 'yes' } });
      const context = f.consent.mock.calls[0]?.[4];
      expect(context?.signal).toBeInstanceOf(AbortSignal);
      expect(context?.deadlineMs).toBeLessThanOrEqual(session.expiresAt * 1000);
      expect(context?.deadlineMs).toBeLessThanOrEqual(Date.now() + 10_000);
    } finally { await f.app.close(); }
  });
});
