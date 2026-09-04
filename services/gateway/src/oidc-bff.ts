import {
  createCipheriv, createDecipheriv, createHash, randomBytes
} from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hello } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';
import {
  AuthError, AuthorizationError, JwksJwtAuthProvider, JwksJwtVerifier, principalFromJwtClaims,
  validatePrincipal,
  type AuthProvider, type JwtClaims, type Principal
} from './auth.js';
import { clearHostSessionCookie, constantTimeText, hasCookie, hostSessionCookie, isHostCookieName, routedPath, scalarHeaderValue, uniqueCookieValue } from './http-auth-primitives.js';

const SESSION_KIND = 'session';
const LOGIN_KIND = 'login';

export interface PendingOidcLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

export interface OidcSession {
  subject: string;
  principal: Principal;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken?: string;
  idToken: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

/** Durable implementations must make takeLogin atomic and expire records fail-closed. */
export interface OidcSessionStore {
  ready(): Promise<void>;
  putLogin(id: string, login: PendingOidcLogin): Promise<void>;
  takeLogin(id: string): Promise<PendingOidcLogin | undefined>;
  getSession(id: string): Promise<OidcSession | undefined>;
  putSession(id: string, session: OidcSession): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

interface EncryptedRow {
  encrypted_payload?: unknown;
}

function recordKey(id: string): Buffer {
  return createHash('sha256').update(id, 'utf8').digest();
}

function encryptionAad(kind: string, key: Buffer): Buffer {
  return Buffer.from(`${kind}:${key.toString('hex')}`, 'utf8');
}

/**
 * Durable encrypted session store. The database sees only SHA-256 record keys and AES-256-GCM
 * ciphertext. The table is intentionally migration-owned; ready() fails startup if it is absent.
 */
export class PostgresOidcSessionStore implements OidcSessionStore {
  private readonly encryptionKey: Buffer;
  private readonly table: string;

  constructor(
    private readonly pool: DatabasePool,
    encryptionKey: Uint8Array,
    table = 'gateway_oidc_sessions'
  ) {
    if (encryptionKey.byteLength !== 32) throw new Error('OIDC session encryption key must be exactly 32 bytes');
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) throw new Error('OIDC session table name is invalid');
    this.encryptionKey = Buffer.from(encryptionKey);
    this.table = `"${table}"`;
  }

  async ready(): Promise<void> {
    await this.pool.query(`SELECT key_hash FROM ${this.table} LIMIT 0`);
  }

  private encrypt(kind: string, id: string, value: unknown): { key: Buffer; payload: Buffer } {
    const key = recordKey(id);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(encryptionAad(kind, key));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { key, payload: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]) };
  }

  private decrypt(kind: string, id: string, value: unknown): unknown {
    if (!Buffer.isBuffer(value) || value.byteLength < 29) throw new AuthError('stored OIDC session is invalid');
    const key = recordKey(id);
    const iv = value.subarray(0, 12);
    const tag = value.subarray(12, 28);
    const ciphertext = value.subarray(28);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAAD(encryptionAad(kind, key));
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as unknown;
    } catch {
      throw new AuthError('stored OIDC session failed authentication');
    }
  }

  private async put(kind: string, id: string, value: unknown, expiresAt: number): Promise<void> {
    const encrypted = this.encrypt(kind, id, value);
    await this.pool.query(
      `INSERT INTO ${this.table} (kind, key_hash, encrypted_payload, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, key_hash) DO UPDATE SET
         encrypted_payload = EXCLUDED.encrypted_payload,
         expires_at = EXCLUDED.expires_at,
         updated_at = CURRENT_TIMESTAMP`,
      [kind, encrypted.key, encrypted.payload, new Date(expiresAt)]
    );
  }

  private async get<T>(kind: string, id: string, consume: boolean): Promise<T | undefined> {
    const key = recordKey(id);
    const command = consume
      ? `DELETE FROM ${this.table} WHERE kind = $1 AND key_hash = $2 AND expires_at > CURRENT_TIMESTAMP RETURNING encrypted_payload`
      : `SELECT encrypted_payload FROM ${this.table} WHERE kind = $1 AND key_hash = $2 AND expires_at > CURRENT_TIMESTAMP`;
    const result = await this.pool.query(command, [kind, key]);
    const row = result.rows[0] as EncryptedRow | undefined;
    return row === undefined ? undefined : this.decrypt(kind, id, row.encrypted_payload) as T;
  }

  async putLogin(id: string, login: PendingOidcLogin): Promise<void> {
    await this.put(LOGIN_KIND, id, login, login.expiresAt);
  }

  async takeLogin(id: string): Promise<PendingOidcLogin | undefined> {
    return this.get(LOGIN_KIND, id, true);
  }

  async getSession(id: string): Promise<OidcSession | undefined> {
    return this.get(SESSION_KIND, id, false);
  }

  async putSession(id: string, session: OidcSession): Promise<void> {
    await this.put(SESSION_KIND, id, session, session.expiresAt);
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table} WHERE kind = $1 AND key_hash = $2`, [SESSION_KIND, recordKey(id)]);
  }
}

interface TokenResponse extends Record<string, unknown> {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
}

export interface OidcBffAuthProviderOptions {
  issuer: string;
  jwksUrl: string | URL;
  bearerProvider: JwksJwtAuthProvider;
  authorizationEndpoint: string | URL;
  tokenEndpoint: string | URL;
  clientId: string;
  clientSecret?: string;
  redirectUri: string | URL;
  sessionStore: OidcSessionStore;
  fetcher?: typeof fetch;
  scopes?: readonly string[];
  postLoginPath?: string;
  sessionCookieName?: string;
  loginCookieName?: string;
  sessionMaxAgeMs?: number;
  loginMaxAgeMs?: number;
  refreshLeewayMs?: number;
  now?: () => number;
}

export interface ConsoleAuthState {
  authenticated: boolean;
  subject?: string;
  roles?: readonly string[];
  permissions?: readonly string[];
  expires_at?: string;
  csrf_token?: string;
}

function secureEndpoint(value: string | URL, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name} must be an HTTPS URL without credentials`);
  return url;
}

function randomOpaque(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function requiredString(value: unknown, name: string, maximum = 16_384): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new AuthError(`OIDC ${name} is invalid`);
  return value;
}

function tokenExpiry(claims: JwtClaims): number {
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new AuthError('OIDC access token expiry is invalid');
  return claims.exp * 1_000;
}

function subject(claims: JwtClaims): string {
  return requiredString(claims.sub, 'subject', 512);
}

function assertAuthorizedParty(claims: JwtClaims, clientId: string): void {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.azp !== undefined && claims.azp !== clientId) throw new AuthError('OIDC ID token authorized party is invalid');
  if (audiences.length > 1 && claims.azp !== clientId) throw new AuthError('OIDC ID token authorized party is invalid');
}

function assertAtHash(claims: JwtClaims, accessToken: string): void {
  if (claims.at_hash === undefined) return;
  const digest = createHash('sha256').update(accessToken, 'utf8').digest();
  const expected = digest.subarray(0, digest.byteLength / 2).toString('base64url');
  if (typeof claims.at_hash !== 'string' || !constantTimeText(claims.at_hash, expected)) {
    throw new AuthError('OIDC access token hash is invalid');
  }
}

/** Browser authentication provider: OAuth tokens never leave this server-side session. */
export class OidcBffAuthProvider implements AuthProvider {
  readonly name = 'oidc-bff';
  readonly mode = 'production' as const;
  readonly sessionCookieName: string;
  readonly loginCookieName: string;
  readonly postLoginPath: string;
  private readonly authorizationEndpoint: URL;
  private readonly tokenEndpoint: URL;
  private readonly redirectUri: URL;
  private readonly clientId: string;
  private readonly clientSecret: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly scopes: readonly string[];
  private readonly store: OidcSessionStore;
  private readonly bearerProvider: JwksJwtAuthProvider;
  private readonly idVerifier: JwksJwtVerifier;
  private readonly sessionMaxAgeMs: number;
  private readonly loginMaxAgeMs: number;
  private readonly refreshLeewayMs: number;
  private readonly now: () => number;
  private readonly requestCache = new WeakMap<FastifyRequest, { id: string; session: OidcSession }>();
  private readonly refreshLocks = new Map<string, Promise<OidcSession>>();

  constructor(options: OidcBffAuthProviderOptions) {
    this.authorizationEndpoint = secureEndpoint(options.authorizationEndpoint, 'OIDC authorization endpoint');
    this.tokenEndpoint = secureEndpoint(options.tokenEndpoint, 'OIDC token endpoint');
    this.redirectUri = secureEndpoint(options.redirectUri, 'OIDC redirect URI');
    this.clientId = requiredString(options.clientId, 'client id', 512);
    this.clientSecret = options.clientSecret;
    this.fetcher = options.fetcher ?? fetch;
    this.scopes = [...new Set(options.scopes ?? ['openid', 'profile'])];
    if (!this.scopes.includes('openid')) throw new Error('OIDC scopes must include openid');
    this.postLoginPath = options.postLoginPath ?? '/';
    if (!this.postLoginPath.startsWith('/') || this.postLoginPath.startsWith('//')) throw new Error('OIDC post-login path must be relative to this origin');
    this.sessionCookieName = options.sessionCookieName ?? '__Host-cauce_session';
    this.loginCookieName = options.loginCookieName ?? '__Host-cauce_login';
    if (!isHostCookieName(this.sessionCookieName) || !isHostCookieName(this.loginCookieName)) {
      throw new Error('OIDC cookies must use the __Host- prefix');
    }
    if (this.sessionCookieName === this.loginCookieName) throw new Error('OIDC session and login cookies must differ');
    this.store = options.sessionStore;
    this.bearerProvider = options.bearerProvider;
    this.sessionMaxAgeMs = options.sessionMaxAgeMs ?? 8 * 60 * 60 * 1_000;
    this.loginMaxAgeMs = options.loginMaxAgeMs ?? 10 * 60 * 1_000;
    this.refreshLeewayMs = options.refreshLeewayMs ?? 30_000;
    if (this.sessionMaxAgeMs <= 0 || this.loginMaxAgeMs <= 0 || this.refreshLeewayMs < 0) throw new Error('OIDC expiry settings are invalid');
    this.now = options.now ?? Date.now;
    const verifierOptions = {
      issuer: options.issuer,
      jwksUrl: options.jwksUrl,
      fetcher: this.fetcher
    };
    this.idVerifier = new JwksJwtVerifier({ ...verifierOptions, audience: this.clientId });
  }

  async ready(): Promise<void> {
    await this.store.ready();
  }

  private sessionId(request: FastifyRequest): string | undefined {
    if (scalarHeaderValue(request.headers.authorization) !== undefined) throw new AuthError('browser bearer credentials are not accepted');
    return uniqueCookieValue(scalarHeaderValue(request.headers.cookie), this.sessionCookieName);
  }

  private usesBearerProvider(request: FastifyRequest): boolean {
    return !hasCookie(scalarHeaderValue(request.headers.cookie), this.sessionCookieName)
      && scalarHeaderValue(request.headers.authorization) !== undefined;
  }

  private async tokenRequest(parameters: URLSearchParams): Promise<TokenResponse> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded'
    };
    if (this.clientSecret !== undefined) {
      headers.authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64')}`;
    } else {
      parameters.set('client_id', this.clientId);
    }
    let response: Response;
    try {
      response = await this.fetcher(this.tokenEndpoint, {
        method: 'POST', headers, body: parameters, redirect: 'error'
      });
    } catch {
      throw new AuthError('OIDC token endpoint is unavailable');
    }
    if (!response.ok) throw new AuthError('OIDC token exchange was rejected');
    return response.json() as Promise<TokenResponse>;
  }

  private async verifiedTokens(tokens: TokenResponse, nonce?: string, previousSubject?: string): Promise<{
    subject: string;
    principal: Principal;
    accessToken: string;
    accessExpiresAt: number;
    refreshToken?: string;
    idToken?: string;
  }> {
    const accessToken = requiredString(tokens.access_token, 'access token');
    if (tokens.token_type !== 'Bearer') throw new AuthError('OIDC token type is invalid');
    const { claims: accessClaims } = await this.bearerProvider.verifyToken(accessToken);
    const accessSubject = subject(accessClaims);
    if (previousSubject !== undefined && accessSubject !== previousSubject) throw new AuthError('OIDC refresh changed subject');
    const tokenPrincipal = principalFromJwtClaims(accessClaims);
    // A successful browser Authorization Code + PKCE flow establishes a person, not merely an
    // operator-capable service principal.  Bind that verified OIDC subject into the encrypted BFF
    // session.  Raw bearer clients do not take this path and therefore gain no implicit human band.
    const principal = tokenPrincipal.roles.includes('operator')
      ? validatePrincipal({ ...tokenPrincipal, operator_id: accessSubject })
      : tokenPrincipal;
    let idToken: string | undefined;
    if (tokens.id_token !== undefined) {
      idToken = requiredString(tokens.id_token, 'ID token');
      const idClaims = await this.idVerifier.verify(idToken);
      assertAuthorizedParty(idClaims, this.clientId);
      if (subject(idClaims) !== accessSubject) throw new AuthError('OIDC token subjects do not match');
      if (nonce !== undefined && (typeof idClaims.nonce !== 'string' || !constantTimeText(idClaims.nonce, nonce))) {
        throw new AuthError('OIDC ID token nonce is invalid');
      }
      assertAtHash(idClaims, accessToken);
    } else if (nonce !== undefined) {
      throw new AuthError('OIDC ID token is required');
    }
    const expiresIn = typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
      ? this.now() + tokens.expires_in * 1_000
      : Number.POSITIVE_INFINITY;
    const refreshToken = tokens.refresh_token === undefined ? undefined : requiredString(tokens.refresh_token, 'refresh token');
    return {
      subject: accessSubject,
      principal,
      accessToken,
      accessExpiresAt: Math.min(tokenExpiry(accessClaims), expiresIn),
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(idToken === undefined ? {} : { idToken })
    };
  }

  private async refresh(id: string, session: OidcSession): Promise<OidcSession> {
    if (!session.refreshToken) {
      await this.store.deleteSession(id);
      throw new AuthError('OIDC session expired');
    }
    try {
      const tokens = await this.tokenRequest(new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken
      }));
      const verified = await this.verifiedTokens(tokens, undefined, session.subject);
      const updated: OidcSession = {
        ...session,
        principal: verified.principal,
        accessToken: verified.accessToken,
        accessExpiresAt: verified.accessExpiresAt,
        refreshToken: verified.refreshToken ?? session.refreshToken,
        idToken: verified.idToken ?? session.idToken
      };
      await this.store.putSession(id, updated);
      return updated;
    } catch (error) {
      await this.store.deleteSession(id);
      if (error instanceof AuthError) throw error;
      throw new AuthError('OIDC session refresh failed');
    }
  }

  private async refreshOnce(id: string, observed: OidcSession): Promise<OidcSession> {
    const active = this.refreshLocks.get(id);
    if (active) return active;
    const operation = (async () => {
      const current = await this.store.getSession(id);
      if (!current || current.expiresAt <= this.now()) throw new AuthError('OIDC session is expired or unknown');
      if (current.accessToken !== observed.accessToken && current.accessExpiresAt > this.now() + this.refreshLeewayMs) {
        return current;
      }
      return this.refresh(id, current);
    })();
    this.refreshLocks.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.refreshLocks.get(id) === operation) this.refreshLocks.delete(id);
    }
  }

  private async load(request: FastifyRequest): Promise<{ id: string; session: OidcSession }> {
    const cached = this.requestCache.get(request);
    if (cached) return cached;
    const id = this.sessionId(request);
    if (!id || id.length < 32 || id.length > 256) throw new AuthError('OIDC session cookie is required');
    let session = await this.store.getSession(id);
    if (!session || session.expiresAt <= this.now()) {
      if (session) await this.store.deleteSession(id);
      throw new AuthError('OIDC session is expired or unknown');
    }
    if (session.accessExpiresAt <= this.now() + this.refreshLeewayMs) session = await this.refreshOnce(id, session);
    const result = { id, session };
    this.requestCache.set(request, result);
    return result;
  }

  async authenticateHttp(request: FastifyRequest): Promise<Principal> {
    if (this.usesBearerProvider(request)) return this.bearerProvider.authenticateHttp(request);
    return (await this.load(request)).session.principal;
  }

  async authenticateHello(request: FastifyRequest, _hello: Hello): Promise<Principal> {
    if (this.usesBearerProvider(request)) return this.bearerProvider.authenticateHello(request);
    return (await this.load(request)).session.principal;
  }

  async requireCsrf(request: FastifyRequest): Promise<void> {
    const { session } = await this.load(request);
    const presented = scalarHeaderValue(request.headers['x-csrf-token']);
    if (!presented || !constantTimeText(presented, session.csrfToken)) throw new AuthorizationError('valid CSRF token is required');
  }

  async authState(request: FastifyRequest): Promise<ConsoleAuthState> {
    try {
      const { session } = await this.load(request);
      return {
        authenticated: true,
        subject: `${session.principal.tenant_id}:${session.principal.alias}`,
        roles: session.principal.roles,
        permissions: session.principal.permissions,
        expires_at: new Date(session.expiresAt).toISOString(),
        csrf_token: session.csrfToken
      };
    } catch (error) {
      if (error instanceof AuthError) return { authenticated: false };
      throw error;
    }
  }

  async beginLogin(reply: FastifyReply): Promise<void> {
    const handle = randomOpaque();
    const state = randomOpaque();
    const nonce = randomOpaque();
    const codeVerifier = randomOpaque(64);
    const expiresAt = this.now() + this.loginMaxAgeMs;
    await this.store.putLogin(handle, { state, nonce, codeVerifier, returnTo: this.postLoginPath, expiresAt });
    const authorization = new URL(this.authorizationEndpoint);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('client_id', this.clientId);
    authorization.searchParams.set('redirect_uri', this.redirectUri.toString());
    authorization.searchParams.set('scope', this.scopes.join(' '));
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('nonce', nonce);
    authorization.searchParams.set('code_challenge', sha256Base64Url(codeVerifier));
    authorization.searchParams.set('code_challenge_method', 'S256');
    reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', hostSessionCookie(this.loginCookieName, handle, this.loginMaxAgeMs / 1_000, 'Lax'))
      .code(302)
      .header('Location', authorization.toString())
      .send();
  }

  async completeLogin(request: FastifyRequest, reply: FastifyReply, code: unknown, state: unknown): Promise<void> {
    const handle = uniqueCookieValue(scalarHeaderValue(request.headers.cookie), this.loginCookieName);
    const clearLogin = clearHostSessionCookie(this.loginCookieName, 'Lax');
    if (!handle) {
      reply.header('Set-Cookie', clearLogin).code(400).send({ error: 'invalid_login', message: 'OIDC login cookie is missing' });
      return;
    }
    const pending = await this.store.takeLogin(handle);
    if (!pending || pending.expiresAt <= this.now() || typeof state !== 'string' || !constantTimeText(state, pending.state)) {
      reply.header('Set-Cookie', clearLogin).code(400).send({ error: 'invalid_login', message: 'OIDC login state is invalid or expired' });
      return;
    }
    try {
      const tokens = await this.tokenRequest(new URLSearchParams({
        grant_type: 'authorization_code',
        code: requiredString(code, 'authorization code'),
        redirect_uri: this.redirectUri.toString(),
        code_verifier: pending.codeVerifier
      }));
      const verified = await this.verifiedTokens(tokens, pending.nonce);
      if (verified.idToken === undefined) throw new AuthError('OIDC ID token is required');
      const oldId = uniqueCookieValue(scalarHeaderValue(request.headers.cookie), this.sessionCookieName);
      if (oldId) await this.store.deleteSession(oldId);
      const id = randomOpaque();
      const now = this.now();
      const session: OidcSession = {
        subject: verified.subject,
        principal: verified.principal,
        accessToken: verified.accessToken,
        accessExpiresAt: verified.accessExpiresAt,
        ...(verified.refreshToken === undefined ? {} : { refreshToken: verified.refreshToken }),
        idToken: verified.idToken,
        csrfToken: randomOpaque(),
        createdAt: now,
        expiresAt: now + this.sessionMaxAgeMs
      };
      await this.store.putSession(id, session);
      reply
        .header('Cache-Control', 'no-store')
        .header('Set-Cookie', [
          clearLogin,
          hostSessionCookie(this.sessionCookieName, id, this.sessionMaxAgeMs / 1_000, 'Strict')
        ])
        .code(302)
        .header('Location', pending.returnTo)
        .send();
    } catch (error) {
      const message = error instanceof AuthError ? error.message : 'OIDC callback failed';
      reply.header('Set-Cookie', clearLogin).code(401).send({ error: 'unauthorized', message });
    }
  }

  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = await this.load(request);
    await this.store.deleteSession(id);
    reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', clearHostSessionCookie(this.sessionCookieName, 'Strict'))
      .code(204)
      .send();
  }
}

function isUnsafe(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

export function registerOidcBff(app: FastifyInstance, provider: OidcBffAuthProvider): void {
  app.addHook('onRequest', async (request, reply) => {
    const dataMutation = routedPath(request.url).startsWith('/v3/') && isUnsafe(request.method);
    const sessionCookie = hasCookie(scalarHeaderValue(request.headers.cookie), provider.sessionCookieName);
    if (!dataMutation || !sessionCookie) return;
    try {
      await provider.requireCsrf(request);
    } catch (error) {
      const status = error instanceof AuthorizationError ? 403 : 401;
      const message = error instanceof Error ? error.message : 'request authentication failed';
      await reply.code(status).send({ error: status === 403 ? 'forbidden' : 'unauthorized', message });
    }
  });

  app.get('/v3/auth/login', async (_request, reply) => {
    await provider.beginLogin(reply);
  });
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/v3/auth/callback', async (request, reply) => {
    if (request.query.error !== undefined) {
      reply
        .header('Set-Cookie', clearHostSessionCookie(provider.loginCookieName, 'Lax'))
        .code(401)
        .send({ error: 'unauthorized', message: 'OIDC provider rejected login' });
      return;
    }
    await provider.completeLogin(request, reply, request.query.code, request.query.state);
  });
  app.get('/v3/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return provider.authState(request);
  });
  app.post('/v3/auth/logout', async (request, reply) => {
    try {
      await provider.logout(request, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'logout failed';
      await reply.code(401).send({ error: 'unauthorized', message });
    }
  });
}
