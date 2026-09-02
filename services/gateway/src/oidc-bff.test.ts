import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { PROTOCOL_VERSION, type Hello } from '@cauce/protocol';
import { buildGateway } from './app.js';
import { JwksJwtAuthProvider } from './auth.js';
import {
  OidcBffAuthProvider,
  type OidcSession, type OidcSessionStore, type PendingOidcLogin
} from './oidc-bff.js';
import { fakePool, fakeRepository, noDeliveryWakes } from './test-support/gateway-doubles.js';

const issuer = 'https://idp.example';
const clientId = 'cauce-console';
const audience = 'cauce-api';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });

interface MemoryRecord<T> {
  value: T;
  expiresAt: number;
}

class MemoryOidcSessionStore implements OidcSessionStore {
  private readonly logins = new Map<string, MemoryRecord<PendingOidcLogin>>();
  private readonly sessions = new Map<string, MemoryRecord<OidcSession>>();

  ready(): Promise<void> { return Promise.resolve(); }

  async putLogin(id: string, login: PendingOidcLogin): Promise<void> {
    this.logins.set(id, { value: structuredClone(login), expiresAt: login.expiresAt });
  }

  async takeLogin(id: string): Promise<PendingOidcLogin | undefined> {
    const record = this.logins.get(id);
    this.logins.delete(id);
    if (!record || record.expiresAt <= Date.now()) return undefined;
    return structuredClone(record.value);
  }

  async getSession(id: string): Promise<OidcSession | undefined> {
    const record = this.sessions.get(id);
    if (!record || record.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return structuredClone(record.value);
  }

  async putSession(id: string, session: OidcSession): Promise<void> {
    this.sessions.set(id, { value: structuredClone(session), expiresAt: session.expiresAt });
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

function jwt(key: KeyObject, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function cookieFrom(response: { headers: Record<string, unknown> }, name: string): string {
  const raw = response.headers['set-cookie'];
  const values = Array.isArray(raw) && raw.every((value) => typeof value === 'string')
    ? raw
    : typeof raw === 'string' ? [raw] : [];
  const selected = values.find((value) => value.startsWith(`${name}=`));
  if (!selected) throw new Error(`missing ${name} cookie`);
  const [cookie] = selected.split(';', 1);
  if (cookie === undefined) throw new Error(`missing ${name} cookie`);
  return cookie;
}

function cookieValue(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
}

async function fixture(idTokenClaims: Record<string, unknown> = {}) {
  let providerNow = Date.now();
  let nonce = '';
  let refreshes = 0;
  let observedChallenge = '';
  let observedVerifier = '';
  const token = (seconds: number) => jwt(privateKey, {
    iss: issuer,
    aud: audience,
    sub: 'operator-1',
    exp: Math.floor(Date.now() / 1_000) + seconds,
    tenant_id: 'Steven',
    alias: 'kant',
    sid: 'oidc-upstream-session',
    channel: 'console',
    roles: ['operator'],
    permissions: ['route', 'read', 'control']
  });
  const idToken = () => jwt(privateKey, {
    iss: issuer,
    aud: clientId,
    sub: 'operator-1',
    exp: Math.floor(Date.now() / 1_000) + 600,
    nonce,
    ...idTokenClaims
  });
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    if (url === `${issuer}/token`) {
      const body = init?.body instanceof URLSearchParams
        ? init.body
        : typeof init?.body === 'string' ? new URLSearchParams(init.body) : new URLSearchParams();
      if (body.get('grant_type') === 'authorization_code') {
        observedVerifier = body.get('code_verifier') ?? '';
        return Response.json({
          access_token: token(5), token_type: 'Bearer', expires_in: 5,
          refresh_token: 'server-side-refresh-token', id_token: idToken()
        });
      }
      refreshes += 1;
      return Response.json({
        access_token: token(600), token_type: 'Bearer', expires_in: 600,
        refresh_token: `rotated-refresh-${String(refreshes)}`
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const store = new MemoryOidcSessionStore();
  const bearerProvider = new JwksJwtAuthProvider({
    issuer,
    audience,
    jwksUrl: `${issuer}/jwks`,
    fetcher
  });
  const provider = new OidcBffAuthProvider({
    issuer,
    jwksUrl: `${issuer}/jwks`,
    bearerProvider,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    clientId,
    redirectUri: 'https://console.example/v3/auth/callback',
    sessionStore: store,
    fetcher,
    now: () => providerNow,
    sessionMaxAgeMs: 60 * 60 * 1_000
  });
  const app = await buildGateway({
    pool: fakePool({ ssl: true }),
    authProvider: provider,
    repository: fakeRepository({ status: vi.fn(async () => ({ online: 1 })) }),
    deliveryWakeSubscriber: noDeliveryWakes
  });
  const login = await app.inject({ method: 'GET', url: '/v3/auth/login' });
  const location = login.headers.location;
  if (location === undefined) throw new Error('missing OIDC authorization location');
  const authorization = new URL(location);
  nonce = authorization.searchParams.get('nonce') ?? '';
  observedChallenge = authorization.searchParams.get('code_challenge') ?? '';
  const loginCookie = cookieFrom(login, '__Host-cauce_login');
  const callback = await app.inject({
    method: 'GET',
    url: `/v3/auth/callback?code=fake-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    headers: { cookie: `${loginCookie}; __Host-cauce_session=attacker-fixed-session-id-that-is-long-enough` }
  });
  const sessionCookie = callback.statusCode === 302 ? cookieFrom(callback, '__Host-cauce_session') : '';
  return {
    app, provider,
    callback,
    sessionCookie,
    get refreshes() { return refreshes; },
    get observedChallenge() { return observedChallenge; },
    get observedVerifier() { return observedVerifier; },
    get bearerToken() { return token(600); },
    advance(ms: number) { providerNow += ms; }
  };
}

describe('OIDC console BFF', () => {
  it('completes code+PKCE, rotates fixation input, refreshes, authorizes API, and logs out', async () => {
    const test = await fixture();
    try {
      expect(test.callback.statusCode).toBe(302);
      expect(test.callback.headers.location).toBe('/');
      const callbackCookies = String(test.callback.headers['set-cookie']);
      expect(callbackCookies).toContain('HttpOnly');
      expect(callbackCookies).toContain('Secure');
      expect(callbackCookies).toContain('SameSite=Strict');
      expect(cookieValue(test.sessionCookie)).not.toBe('attacker-fixed-session-id-that-is-long-enough');
      expect(test.observedChallenge).toBe(createHash('sha256').update(test.observedVerifier).digest('base64url'));

      const auth = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie: test.sessionCookie } });
      expect(auth.statusCode).toBe(200);
      expect(auth.json()).toMatchObject({ authenticated: true, subject: 'Steven:kant' });
      expect(test.refreshes).toBe(1);
      const csrf = auth.json<{ csrf_token: string }>().csrf_token;

      const api = await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie: test.sessionCookie } });
      expect(api.statusCode).toBe(200);
      expect(api.json()).toMatchObject({ online: 1, auth_provider: 'oidc-bff' });
      const principal = await test.provider.authenticateHttp({
        headers: { cookie: test.sessionCookie }
      } as unknown as FastifyRequest);
      expect(principal.operator_id).toBe('operator-1');
      const bearerAttempt = await test.app.inject({
        method: 'GET', url: '/v3/status',
        headers: { cookie: test.sessionCookie, authorization: 'Bearer browser-must-not-send-this' }
      });
      expect(bearerAttempt.statusCode).toBe(401);

      const rejected = await test.app.inject({
        method: 'POST', url: '/v3/auth/logout',
        headers: { cookie: test.sessionCookie, origin: 'http://localhost', 'x-csrf-token': 'wrong' }
      });
      expect(rejected.statusCode).toBe(403);
      const missingCsrf = await test.app.inject({
        method: 'POST', url: '/v3/auth/logout',
        headers: { cookie: test.sessionCookie, origin: 'http://localhost' }
      });
      expect(missingCsrf.statusCode).toBe(403);
      const logout = await test.app.inject({
        method: 'POST', url: '/v3/auth/logout',
        headers: { cookie: test.sessionCookie, origin: 'http://localhost', 'x-csrf-token': csrf }
      });
      expect(logout.statusCode).toBe(204);
      expect(logout.headers['set-cookie']).toContain('SameSite=Strict');
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie: test.sessionCookie } })).statusCode).toBe(401);
    } finally {
      await test.app.close();
    }
  });

  it('routes bearer-only HTTP and hello authentication through JWKS without browser CSRF', async () => {
    const test = await fixture();
    try {
      const authorization = `Bearer ${test.bearerToken}`;
      const anonymous = await test.app.inject({ method: 'GET', url: '/v3/status' });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toMatchObject({ message: 'OIDC session cookie is required' });

      const api = await test.app.inject({
        method: 'GET', url: '/v3/status', headers: { authorization }
      });
      expect(api.statusCode).toBe(200);
      expect(api.json()).toMatchObject({ online: 1, auth_provider: 'oidc-bff' });

      const mutation = await test.app.inject({
        method: 'POST',
        url: '/v3/heartbeat',
        headers: { authorization },
        payload: {
          type: 'heartbeat',
          instance_id: 'oidc-bearer-test',
          epoch: 1,
          connection_token: '11111111-2222-4333-8444-555555555555'
        }
      });
      expect(mutation.statusCode).toBe(200);

      const crossOrigin = await test.app.inject({
        method: 'POST',
        url: '/v3/console/messages',
        headers: { authorization, origin: 'https://evil.example' },
        payload: {}
      });
      expect(crossOrigin.statusCode).toBe(403);

      const request = { headers: { authorization } } as unknown as FastifyRequest;
      const hello: Hello = {
        type: 'hello',
        version: PROTOCOL_VERSION,
        tenant_id: 'Steven',
        alias: 'kant',
        instance_id: 'oidc-bearer-test',
        capabilities: []
      };
      const principal = await test.provider.authenticateHello(request, hello);
      expect(principal).toMatchObject({ tenant_id: 'Steven', alias: 'kant' });
      expect(principal.operator_id).toBeUndefined();
    } finally {
      await test.app.close();
    }
  });

  it('fails closed on absolute expiry and cross-origin console/session requests', async () => {
    const test = await fixture();
    try {
      const cors = await test.app.inject({
        method: 'GET', url: '/v3/auth/session',
        headers: { cookie: test.sessionCookie, origin: 'https://evil.example' }
      });
      expect(cors.statusCode).toBe(403);
      expect(cors.headers['access-control-allow-origin']).toBeUndefined();

      test.advance(2 * 60 * 60 * 1_000);
      const expired = await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie: test.sessionCookie } });
      expect(expired.statusCode).toBe(401);
    } finally {
      await test.app.close();
    }
  });

  it('rejects a mismatched ID-token authorized party even with one valid audience', async () => {
    const test = await fixture({ azp: 'different-client' });
    try {
      expect(test.callback.statusCode).toBe(401);
      expect(test.callback.json()).toMatchObject({
        error: 'unauthorized',
        message: 'OIDC ID token authorized party is invalid'
      });
      expect(String(test.callback.headers['set-cookie'])).not.toContain('__Host-cauce_session=');
    } finally {
      await test.app.close();
    }
  });
});
