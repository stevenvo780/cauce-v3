import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthError, AuthorizationError, validatePrincipal,
  type AuthProvider, type Principal, type PrincipalPermission, type PrincipalRole
} from './auth.js';
import type { ConsoleUser, ConsoleUserRole, ConsoleUserStore } from './console-users.js';
import { clearHostSessionCookie, constantTimeText, hostSessionCookie, isHostCookieName, routedPath, scalarHeaderValue, uniqueCookieValue } from './http-auth-primitives.js';
import { DECOY_PASSWORD_HASH_PROMISE, MAX_PASSWORD_LENGTH, verifyPassword } from './password.js';

/**
 * Password authentication provider for console users.
 * Emits an HttpOnly session cookie carrying a signed JWT and delegates to the
 * fallback provider (such as mTLS) any request that does not carry that cookie.
 * Role and permissions are revalidated against the user store on every request.
 */

const JWT_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
const JWT_ISSUER = 'cauce-v3-gateway';
const JWT_AUDIENCE = 'cauce-v3-console';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const MIN_SIGNING_KEY_BYTES = 32;
/** Single message for "not found", "wrong password", and "disabled account". See `login()`. */
const CREDENTIAL_FAILURE_MESSAGE = 'Correo o contraseña incorrectos.';

export interface ConsoleSessionClaims {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  csrf: string;
  iat: number;
  exp: number;
}

export type LoginMode = 'password' | 'redirect';

export interface ConsolePasswordAuthState {
  authenticated: boolean;
  login_mode: LoginMode;
  subject?: string;
  name?: string;
  roles?: readonly string[];
  permissions?: readonly string[];
  expires_at?: string;
  csrf_token?: string;
  reason?: string;
}

/** Distinguished from the rest of `AuthError` only so the user can be told what happened. */
class SessionExpiredError extends AuthError {
  constructor() {
    super('La sesión venció. Volvé a iniciar sesión.');
  }
}

/**
 * Console role -> Cauce authority. This is the MINIMUM reasonable mapping and lives in the code
 * rather than the database because it is a product decision, not data: `operator` operates
 * (publish, cancel, retry, terminals) and `reader` only watches. Either is then narrowed by
 * `memberships`/`role_policies`.
 */
const ROLE_AUTHORITY: Readonly<Record<ConsoleUserRole, {
  roles: readonly PrincipalRole[]; permissions: readonly PrincipalPermission[];
}>> = Object.freeze({
  operator: { roles: ['operator'], permissions: ['route', 'read', 'control', 'notify'] },
  reader: { roles: [], permissions: ['read'] }
});

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function signConsoleSession(key: Buffer, claims: ConsoleSessionClaims): string {
  const payload = base64urlJson(claims);
  const signature = createHmac('sha256', key).update(`${JWT_HEADER}.${payload}`).digest('base64url');
  return `${JWT_HEADER}.${payload}.${signature}`;
}

/**
 * Full verification before looking at ANY content: algorithm hardcoded on the server (an `alg`
 * coming in the token is never read — that is how `alg: none` slips in), signature compared in
 * constant time, and only then the payload is decoded.
 */
export function verifyConsoleSession(key: Buffer, token: string, nowMs: number): ConsoleSessionClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new AuthError('token de sesión malformado');
  const [header, payload, signature] = parts as [string, string, string];
  if (header !== JWT_HEADER) throw new AuthError('cabecera de token no aceptada');
  const expected = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  if (!constantTimeText(signature, expected)) throw new AuthError('firma de token inválida');
  let claims: Partial<ConsoleSessionClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<ConsoleSessionClaims>;
  } catch {
    throw new AuthError('token de sesión malformado');
  }
  if (claims.iss !== JWT_ISSUER || claims.aud !== JWT_AUDIENCE) throw new AuthError('token de sesión ajeno');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 128) {
    throw new AuthError('sujeto del token inválido');
  }
  if (typeof claims.sid !== 'string' || claims.sid.length < 16 || claims.sid.length > 128) {
    throw new AuthError('identificador de sesión inválido');
  }
  if (typeof claims.csrf !== 'string' || claims.csrf.length < 32 || claims.csrf.length > 128) {
    throw new AuthError('token CSRF de la sesión inválido');
  }
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) throw new AuthError('emisión del token inválida');
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new AuthError('vencimiento del token inválido');
  // No clock-skew tolerance for the future: issuer and verifier are THE SAME process.
  if (claims.exp * 1_000 <= nowMs) throw new SessionExpiredError();
  return claims as ConsoleSessionClaims;
}

/**
 * Brute-force brake, in memory and keyed by normalized email.
 *
 * In memory on purpose: the gateway runs in one process, and a counter in PostgreSQL would add
 * one write per failed attempt on the least authenticated path that exists. If the process
 * restarts the counter is lost — that is the cheap side of the error, and scrypt already sets
 * the per-attempt cost.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; blockedUntil: number; seenAt: number }>();

  constructor(
    private readonly maxFailures = 8,
    private readonly windowMs = 15 * 60 * 1_000,
    private readonly maxTracked = 10_000
  ) {}

  /** Milliseconds until another attempt is allowed, or 0 if an attempt can be made now. */
  retryAfterMs(key: string, now: number): number {
    const record = this.failures.get(key);
    if (!record) return 0;
    if (record.blockedUntil <= now) return 0;
    return record.blockedUntil - now;
  }

  recordFailure(key: string, now: number): void {
    this.prune(now);
    const record = this.failures.get(key);
    if (!record || now - record.seenAt > this.windowMs) {
      this.failures.set(key, { count: 1, blockedUntil: 0, seenAt: now });
      return;
    }
    record.count += 1;
    record.seenAt = now;
    if (record.count >= this.maxFailures) record.blockedUntil = now + this.windowMs;
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  private prune(now: number): void {
    if (this.failures.size < this.maxTracked) return;
    for (const [key, record] of this.failures) {
      if (record.blockedUntil <= now && now - record.seenAt > this.windowMs) this.failures.delete(key);
    }
    // If it is still full after that, the whole map is cleared: we prefer losing counters to
    // growing without a ceiling. An attacker can force this, but it costs 10,000 verifications.
    if (this.failures.size >= this.maxTracked) this.failures.clear();
  }
}

export interface PasswordAuthProviderOptions {
  users: ConsoleUserStore;
  /** HMAC key for the JWT. Comes from a secret file, never from the repository or the browser. */
  signingKey: Uint8Array;
  /** Provider that handles anything that does NOT carry a session cookie: today, the agents' mTLS. */
  fallback?: AuthProvider;
  sessionTtlMs?: number;
  cookieName?: string;
  now?: () => number;
  throttle?: LoginThrottle;
  /**
   * Channel of the machine principal associated with the web console.
   * Requires an explicit human session to access console surface routes, preventing the proxy's
   * transport certificate from authorizing anonymous web access.
   */
  machineChannelRequiringSession?: string;
}

/** Single message at the session gate: it does not distinguish "no cookie" from "cookie does not apply here". */
const SESSION_REQUIRED_MESSAGE = 'se requiere la cookie de sesión de la consola';

/**
 * Determines whether a URL belongs to the console surface that requires a user session.
 * Protects administrative and status routes against direct browser access without a session.
 */
export function isConsoleSurface(url: string): boolean {
  const path = routedPath(url);
  return path.startsWith('/v3/console/') || path === '/v3/status';
}

interface LoadedSession {
  claims: ConsoleSessionClaims;
  user: ConsoleUser;
  principal: Principal;
}

export class PasswordAuthProvider implements AuthProvider {
  readonly name = 'console-password';
  readonly mode = 'production' as const;
  readonly cookieName: string;
  readonly fallback: AuthProvider | undefined;
  private readonly users: ConsoleUserStore;
  private readonly signingKey: Buffer;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly throttle: LoginThrottle;
  private readonly machineChannelRequiringSession: string;
  private readonly requestCache = new WeakMap<FastifyRequest, LoadedSession>();

  constructor(options: PasswordAuthProviderOptions) {
    if (options.signingKey.byteLength < MIN_SIGNING_KEY_BYTES) {
      throw new Error(`la clave de firma de la consola necesita al menos ${String(MIN_SIGNING_KEY_BYTES)} bytes`);
    }
    this.users = options.users;
    this.signingKey = Buffer.from(options.signingKey);
    this.fallback = options.fallback;
    this.cookieName = options.cookieName ?? '__Host-cauce_session';
    if (!isHostCookieName(this.cookieName)) {
      throw new Error('la cookie de sesión debe usar el prefijo __Host-');
    }
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isFinite(this.sessionTtlMs) || this.sessionTtlMs <= 0) {
      throw new Error('la vida de la sesión de consola debe ser positiva');
    }
    this.now = options.now ?? Date.now;
    this.throttle = options.throttle ?? new LoginThrottle();
    this.machineChannelRequiringSession = options.machineChannelRequiringSession ?? 'console';
  }

  /**
   * Anything without a cookie passes through here, exiting with the MACHINE identity of the `fallback`.
   *
   * The only exception is the CONSOLE surface requested by the principal with a browser on the
   * other side (the proxy certificate, `console` channel): there a person with a session is
   * required and the certificate does not replace one. Outside that intersection mTLS rules, so
   * the bus (`/v3/messages`, `/v3/query`, `/v3/quotas/samples`, `/v3/egress/notifications`,
   * `/v3/ws`...) stays open to ALL machine principals, including the proxy's.
   */
  private async viaFallback(
    request: FastifyRequest,
    resolve: (provider: AuthProvider) => Promise<Principal>
  ): Promise<Principal> {
    if (!this.fallback) throw new AuthError(SESSION_REQUIRED_MESSAGE);
    const machine = await resolve(this.fallback);
    if (machine.channel === this.machineChannelRequiringSession && isConsoleSurface(request.url)) {
      throw new AuthError(SESSION_REQUIRED_MESSAGE);
    }
    return machine;
  }

  async ready(): Promise<void> {
    await this.users.ready();
  }

  private token(request: FastifyRequest): string | undefined {
    return uniqueCookieValue(scalarHeaderValue(request.headers.cookie), this.cookieName);
  }

  private principalFor(user: ConsoleUser, claims: ConsoleSessionClaims): Principal {
    const authority = ROLE_AUTHORITY[user.role];
    return validatePrincipal({
      tenant_id: user.tenant_id,
      alias: user.alias,
      session_id: `console:${claims.sid}`,
      channel: 'console',
      roles: authority.roles,
      permissions: authority.permissions,
      // Identifier of the authenticated operator, derived from the console account.
      operator_id: user.email,
      /*
       * A web session is not a return transport. The human identity is tracked through
       * operator_id and session_id without registering as a durable delivery route.
       */
    });
  }

  private async load(request: FastifyRequest): Promise<LoadedSession> {
    const cached = this.requestCache.get(request);
    if (cached) return cached;
    const token = this.token(request);
    if (token === undefined) throw new AuthError(SESSION_REQUIRED_MESSAGE);
    const claims = verifyConsoleSession(this.signingKey, token, this.now());
    const user = await this.users.findById(claims.sub);
    // ALWAYS re-read. A signed token is not authority over the current state of the account.
    if (!user?.active) throw new AuthError('la cuenta de consola no está habilitada');
    // Changing the password invalidates previously issued tokens: revocation without a revocation table.
    if (claims.iat * 1_000 < user.password_changed_at - 1_000) throw new SessionExpiredError();
    const loaded = { claims, user, principal: this.principalFor(user, claims) };
    this.requestCache.set(request, loaded);
    return loaded;
  }

  /** `true` when the request carries the console cookie; the rest belongs to the `fallback` (mTLS). */
  handles(request: FastifyRequest): boolean {
    return this.token(request) !== undefined;
  }

  async authenticateHttp(request: FastifyRequest): Promise<Principal> {
    if (!this.handles(request)) {
      return this.viaFallback(request, (provider) => provider.authenticateHttp(request));
    }
    return (await this.load(request)).principal;
  }

  async authenticateHello(request: FastifyRequest, hello: Parameters<AuthProvider['authenticateHello']>[1]): Promise<Principal> {
    if (!this.handles(request)) {
      return this.viaFallback(request, (provider) => provider.authenticateHello(request, hello));
    }
    return (await this.load(request)).principal;
  }

  async requireCsrf(request: FastifyRequest): Promise<void> {
    const { claims } = await this.load(request);
    const presented = scalarHeaderValue(request.headers['x-csrf-token']);
    if (!presented || !constantTimeText(presented, claims.csrf)) {
      throw new AuthorizationError('se requiere un token CSRF válido');
    }
  }

  async authState(request: FastifyRequest): Promise<ConsolePasswordAuthState> {
    if (!this.handles(request)) return { authenticated: false, login_mode: 'password' };
    try {
      const { claims, user } = await this.load(request);
      const authority = ROLE_AUTHORITY[user.role];
      return {
        authenticated: true,
        login_mode: 'password',
        subject: user.email,
        name: user.display_name,
        roles: authority.roles,
        permissions: authority.permissions,
        expires_at: new Date(claims.exp * 1_000).toISOString(),
        csrf_token: claims.csrf
      };
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        return { authenticated: false, login_mode: 'password', reason: error.message };
      }
      if (error instanceof AuthError) return { authenticated: false, login_mode: 'password' };
      throw error;
    }
  }

  private issue(user: ConsoleUser): { token: string; claims: ConsoleSessionClaims } {
    const issuedAtMs = this.now();
    const claims: ConsoleSessionClaims = {
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      sub: user.id,
      sid: randomUUID(),
      csrf: randomBytes(32).toString('base64url'),
      iat: Math.floor(issuedAtMs / 1_000),
      exp: Math.floor((issuedAtMs + this.sessionTtlMs) / 1_000)
    };
    return { token: signConsoleSession(this.signingKey, claims), claims };
  }

  /**
   * ONE SINGLE MESSAGE for the three failure modes (unknown email, wrong password, disabled
   * account) and the SAME cryptographic work in every case: if the email does not exist the
   * password is still checked against a decoy hash. A different message —or a faster response—
   * turns login into a directory of who has an account.
   */
  async login(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body: unknown = request.body;
    const fields = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
    const email = fields.email;
    const password = fields.password;
    if (typeof email !== 'string' || email.length === 0 || email.length > 254 ||
        typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      await reply.code(400).send({ error: 'invalid_request', message: 'Hacen falta correo y contraseña.' });
      return;
    }
    const now = this.now();
    const throttleKey = email.trim().toLowerCase();
    const retryAfterMs = this.throttle.retryAfterMs(throttleKey, now);
    if (retryAfterMs > 0) {
      await reply
        .header('Retry-After', String(Math.ceil(retryAfterMs / 1_000)))
        .code(429)
        .send({ error: 'too_many_requests', message: 'Demasiados intentos fallidos. Probá de nuevo más tarde.' });
      return;
    }
    const user = await this.users.findByEmail(email);
    const hash = user?.password_hash ?? await DECOY_PASSWORD_HASH_PROMISE;
    const verified = await verifyPassword(hash, password);
    if (!user || !verified || !user.active) {
      this.throttle.recordFailure(throttleKey, now);
      await reply
        .header('Cache-Control', 'no-store')
        .code(401)
        .send({ error: 'unauthorized', message: CREDENTIAL_FAILURE_MESSAGE });
      return;
    }
    this.throttle.recordSuccess(throttleKey);
    const { token, claims } = this.issue(user);
    try {
      await this.users.recordLogin(user.id, new Date(now));
    } catch {
      // The last-login marker is informational: losing it must never cost the login itself.
    }
    const authority = ROLE_AUTHORITY[user.role];
    await reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', hostSessionCookie(this.cookieName, token, this.sessionTtlMs / 1_000, 'Strict'))
      .code(200)
      .send({
        authenticated: true,
        login_mode: 'password',
        subject: user.email,
        name: user.display_name,
        roles: authority.roles,
        permissions: authority.permissions,
        expires_at: new Date(claims.exp * 1_000).toISOString(),
        csrf_token: claims.csrf
      } satisfies ConsolePasswordAuthState);
  }

  /**
   * Logging out means clearing the cookie, and that is all it can be: the token is self-contained.
   * That is why the session lifetime is short and why `active=false` and a password change really
   * cut off access — a token stolen BEFORE logout simply expires, or is killed by disabling the
   * account. Replies 204 even if there was no session: closing something already closed is not an error.
   */
  async logout(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', clearHostSessionCookie(this.cookieName, 'Strict'))
      .code(204)
      .send();
  }
}

function isUnsafe(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

export function registerPasswordAuth(app: FastifyInstance, provider: PasswordAuthProvider): void {
  app.addHook('onRequest', async (request, reply) => {
    // CSRF is required ONLY for what travels with a cookie: it is the ambient credential a third-party
    // site can make the browser send on its own. An mTLS agent has no way to obtain a CSRF token,
    // nor needs one, and requiring it would leave it unable to publish anything.
    const path = routedPath(request.url);
    if (!path.startsWith('/v3/') || !isUnsafe(request.method)) return;
    if (path === '/v3/auth/login') return;
    if (!provider.handles(request)) return;
    try {
      await provider.requireCsrf(request);
    } catch (error) {
      const status = error instanceof AuthorizationError ? 403 : 401;
      const message = error instanceof Error ? error.message : 'falló la autenticación del request';
      await reply.code(status).send({ error: status === 403 ? 'forbidden' : 'unauthorized', message });
    }
  });

  app.post('/v3/auth/login', async (request, reply) => {
    await provider.login(request, reply);
  });
  app.get('/v3/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return provider.authState(request);
  });
  app.post('/v3/auth/logout', async (request, reply) => {
    await provider.logout(request, reply);
  });
}
