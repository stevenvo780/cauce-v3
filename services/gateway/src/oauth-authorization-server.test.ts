import { createHash, generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { buildTestGateway } from './test-support/gateway-doubles.js';
import { describe, expect, it, vi } from 'vitest';
import { OAuthClients } from './oauth-client-metadata.js';
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

async function fixture(authenticated = true) {
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
  const store: OAuthStore = { createRequest: async (value) => { pending = value; },
    request: async (id, browser) => pending?.idHash === id && pending.browserHash === browser ? pending : undefined,
    consent, exchange, validate: async () => true, grants: async () => [], revoke: vi.fn(async () => undefined) };
  const clients = new OAuthClients({ fetch: async () => ({ body: JSON.stringify({ client_id: clientId,
    client_name: '<script>unsafe</script>', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) }) });
  const login = vi.fn(async (_request, reply: Parameters<import('./password-auth.js').PasswordAuthProvider['login']>[1]) => { await reply.code(200).send({ authenticated: true }); });
  await registerOAuthAuthorizationServer(app, { clients, tokens, store, passwordAuth: { login, verifyCredentialStamp: () => false },
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
      expect(response.json()).not.toHaveProperty('registration_endpoint');
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
