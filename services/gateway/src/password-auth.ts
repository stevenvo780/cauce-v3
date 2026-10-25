import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorLabel } from '@cauce/protocol';
import {
  AuthError, AuthorizationError,
  type AuthProvider, type Principal
} from './auth.js';
import type { ConsoleUser, ConsoleUserStore } from './console-users.js';
import { createConsoleCredentialStamp, verifyConsoleCredentialStamp } from './console-credential-stamp.js';
import { COMPANY_ID_PATTERN, StoreError, type ConsoleCredentialSnapshot } from '@cauce/store';
import { clearHostSessionCookie, constantTimeText, hostSessionCookie, isHostCookieName, routedPath, scalarHeaderValue, uniqueCookieValue } from './http-auth-primitives.js';
import {
  consoleRoleAuthority, consoleUserPrincipal, type ConsoleCompanyAuthority, type ConsoleSessionAuthority,
} from './console-user-authority.js';
import { DECOY_PASSWORD_HASH_PROMISE, MAX_PASSWORD_LENGTH, verifyPassword } from './password.js';
import { rateLimitKey } from './client-ip.js';

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
  credential_stamp?: string;
  /** Company a platform administrator switched to; every authority decision revalidates it against the database. */
  cmp?: string;
}

export type LoginMode = 'password' | 'redirect';

export interface ConsolePasswordAuthState {
  authenticated: boolean;
  login_mode: LoginMode;
  subject?: string;
  home_tenant?: string;
  name?: string;
  roles?: readonly string[];
  permissions?: readonly string[];
  expires_at?: string;
  csrf_token?: string;
  reason?: string;
  authority?: ConsoleSessionAuthority;
}

/** Distinguished from the rest of `AuthError` only so the user can be told what happened. */
class SessionExpiredError extends AuthError {
  constructor() {
    super('La sesión venció. Vuelve a iniciar sesión.');
  }
}

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
  if (claims.credential_stamp !== undefined
      && (typeof claims.credential_stamp !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claims.credential_stamp))) {
    throw new AuthError('sello de credenciales inválido');
  }
  if (claims.cmp !== undefined && (typeof claims.cmp !== 'string' || !COMPANY_ID_PATTERN.test(claims.cmp))) {
    throw new AuthError('empresa de la sesión inválida');
  }
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
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly maxFailures = 8,
    private readonly windowMs = 15 * 60 * 1_000,
    private readonly maxTracked = 10_000
  ) {}

  /** Milliseconds until another attempt is allowed, or 0 if an attempt can be made now. */
  retryAfterMs(key: string, now: number, maxPending = this.maxFailures): number {
    const record = this.failures.get(key);
    const pending = this.pending.get(key) ?? 0;
    if (!record) return pending >= Math.min(this.maxFailures, maxPending) ? 1_000 : 0;
    this.failures.delete(key);
    this.failures.set(key, record);
    if (record.blockedUntil > now) return record.blockedUntil - now;
    const failures = now - record.seenAt >= this.windowMs ? 0 : record.count;
    return pending >= maxPending || failures + pending >= this.maxFailures ? 1_000 : 0;
  }

  recordFailure(key: string, now: number): void {
    const record = this.track(key, now);
    record.count += 1;
    if (record.count >= this.maxFailures) record.blockedUntil = now + this.windowMs;
  }

  reserve(key: string): () => void {
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    return () => {
      const remaining = (this.pending.get(key) ?? 1) - 1;
      if (remaining === 0) this.pending.delete(key);
      else this.pending.set(key, remaining);
    };
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  private track(key: string, now: number) {
    let record = this.failures.get(key);
    if (!record) {
      this.prune();
      record = { count: 0, blockedUntil: 0, seenAt: now };
    } else if (now - record.seenAt >= this.windowMs) {
      record.count = 0; record.blockedUntil = 0;
    }
    record.seenAt = now;
    this.failures.delete(key);
    this.failures.set(key, record);
    return record;
  }

  private prune(): void {
    if (this.failures.size < this.maxTracked) return;
    const oldest = this.failures.keys().next().value;
    if (oldest !== undefined) this.failures.delete(oldest);
  }
}

export class PasswordWorkSaturated extends Error {
  constructor() { super('password work is saturated'); }
}

/**
 * Each scrypt derivation holds ~33 MB and a libuv thread (four by default, shared with file and DNS work) for ~100 ms,
 * so derivations share a process gate. Background work cannot occupy the reserved login slot or queue.
 */
export class PasswordWorkGate {
  private running = 0;
  private runningBackground = 0;
  private readonly logins: (() => void)[] = [];
  private readonly background: (() => void)[] = [];

  constructor(private readonly concurrency = 2, private readonly maxWaiting = 16) {}

  async run<T>(work: () => Promise<T>, kind: 'login' | 'background' = 'background'): Promise<T> {
    const waiting = kind === 'login' ? this.logins : this.background;
    if (this.running < this.concurrency && (kind === 'login' || this.backgroundAvailable())) this.start(kind);
    else if (waiting.length >= this.maxWaiting) throw new PasswordWorkSaturated();
    else if (kind === 'login') await new Promise<void>(resolve => { waiting.push(resolve); });
    else await new Promise<void>((resolve, reject) => {
      const ready = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(() => {
        const index = waiting.indexOf(ready);
        if (index < 0) return;
        waiting.splice(index, 1);
        reject(new PasswordWorkSaturated());
      }, 10_000);
      waiting.push(ready);
    });
    try {
      return await work();
    } finally {
      this.running -= 1;
      if (kind === 'background') this.runningBackground -= 1;
      this.drain();
    }
  }

  private backgroundAvailable(): boolean { return this.runningBackground < Math.max(1, this.concurrency - 1); }

  private start(kind: 'login' | 'background'): void {
    this.running += 1;
    if (kind === 'background') this.runningBackground += 1;
  }

  private drain(): void {
    while (this.running < this.concurrency) {
      const login = this.logins.shift();
      const next = login ?? (this.backgroundAvailable() ? this.background.shift() : undefined);
      if (!next) return;
      this.start(login ? 'login' : 'background');
      next();
    }
  }
}

export const passwordWork = new PasswordWorkGate();

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
  /** Keyed by the real client address; a successful login never resets it, or one valid account would launder guesses. */
  addressThrottle?: LoginThrottle;
  /**
   * Channel of the machine principal associated with the web console.
   * Requires an explicit human session to access console surface routes, preventing the proxy's
   * transport certificate from authorizing anonymous web access.
   */
  machineChannelRequiringSession?: string;
  companyAuthority?: ConsoleCompanyAuthority;
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

export interface VerifiedConsoleSession {
  readonly humanId: string;
  readonly loginSid: string;
  readonly tenantId: Principal['tenant_id'];
  readonly actorAlias: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly credentialStamp?: string;
  /** The raw `cmp` claim; the store resolver decides inside the caller transaction whether it holds. */
  readonly requestedCompany?: string;
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
  private readonly addressThrottle: LoginThrottle;
  private readonly machineChannelRequiringSession: string;
  private companyAuthority: ConsoleCompanyAuthority | undefined;
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
    this.addressThrottle = options.addressThrottle ?? new LoginThrottle(20);
    this.machineChannelRequiringSession = options.machineChannelRequiringSession ?? 'console';
    this.companyAuthority = options.companyAuthority;
  }

  /** The gateway supplies its database resolver unless the caller injected one; without any, `cmp` is ignored. */
  useCompanyAuthority(authority: ConsoleCompanyAuthority): void {
    this.companyAuthority ??= authority;
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

  private async load(request: FastifyRequest): Promise<LoadedSession> {
    const cached = this.requestCache.get(request);
    if (cached) return cached;
    const token = this.token(request);
    if (token === undefined) throw new AuthError(SESSION_REQUIRED_MESSAGE);
    const claims = verifyConsoleSession(this.signingKey, token, this.now());
    const user = await this.users.findById(claims.sub);
    // ALWAYS re-read. A signed token is not authority over the current state of the account.
    if (!user?.active) throw new AuthError('la cuenta de consola no está habilitada');
    if (claims.credential_stamp !== undefined && !this.verifyCredentialStamp(claims.credential_stamp, credentialSnapshot(user))) {
      throw new SessionExpiredError();
    }
    // Changing the password invalidates previously issued tokens: revocation without a revocation table.
    if (claims.iat * 1_000 < user.password_changed_at - 1_000) throw new SessionExpiredError();
    const loaded = { claims, user, principal: consoleUserPrincipal(user, `console:${claims.sid}`, 'console') };
    this.requestCache.set(request, loaded);
    return loaded;
  }

  verifyCredentialStamp(stamp: string, current: Readonly<ConsoleCredentialSnapshot>): boolean {
    return verifyConsoleCredentialStamp(this.signingKey, stamp, current);
  }

  /** `true` when the request carries the console cookie; the rest belongs to the `fallback` (mTLS). */
  handles(request: FastifyRequest): boolean {
    return this.token(request) !== undefined;
  }

  async verifiedConsoleSession(request: FastifyRequest): Promise<Readonly<VerifiedConsoleSession> | undefined> {
    if (!this.handles(request)) return undefined;
    const { claims, user, principal } = await this.load(request);
    return Object.freeze({ humanId: user.id, loginSid: claims.sid, tenantId: principal.tenant_id, actorAlias: principal.alias,
      issuedAtMs: claims.iat * 1000, expiresAtMs: claims.exp * 1000,
      ...(claims.credential_stamp === undefined ? {} : { credentialStamp: claims.credential_stamp }),
      ...(claims.cmp === undefined ? {} : { requestedCompany: claims.cmp }) });
  }

  async authenticateHttp(request: FastifyRequest): Promise<Principal> {
    if (!this.handles(request)) {
      return this.viaFallback(request, (provider) => provider.authenticateHttp(request));
    }
    return (await this.load(request)).principal;
  }

  async authenticateConsoleFresh(request: FastifyRequest): Promise<Principal> {
    if (!this.handles(request)) throw new AuthError(SESSION_REQUIRED_MESSAGE);
    this.requestCache.delete(request);
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

  private sessionState(claims: ConsoleSessionClaims, user: ConsoleUser, authority?: ConsoleSessionAuthority): ConsolePasswordAuthState {
    const ceiling = consoleRoleAuthority(user.role);
    return {
      authenticated: true,
      login_mode: 'password',
      subject: user.email,
      home_tenant: user.tenant_id,
      name: user.display_name,
      roles: ceiling.roles,
      permissions: ceiling.permissions,
      expires_at: new Date(claims.exp * 1_000).toISOString(),
      csrf_token: claims.csrf,
      ...(authority === undefined ? {} : { authority })
    };
  }

  async authState(request: FastifyRequest): Promise<ConsolePasswordAuthState> {
    if (!this.handles(request)) return { authenticated: false, login_mode: 'password' };
    try {
      const { claims, user } = await this.load(request);
      return this.sessionState(claims, user, await this.sessionAuthority(request, user, claims.cmp));
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        return { authenticated: false, login_mode: 'password', reason: error.message };
      }
      if (error instanceof AuthError || (error instanceof StoreError && error.code === 'forbidden')) {
        return { authenticated: false, login_mode: 'password' };
      }
      throw error;
    }
  }

  /** Advisory: a database failure omits the block, and the console assumes none or keeps the one it already holds. */
  private async sessionAuthority(
    request: FastifyRequest, user: ConsoleUser, requested: string | undefined,
  ): Promise<ConsoleSessionAuthority | undefined> {
    try {
      return await this.companyAuthority?.resolve(user, requested);
    } catch (error) {
      if (error instanceof AuthError || (error instanceof StoreError && error.code === 'forbidden')) throw error;
      request.log.warn({ event: 'console_session_authority_unavailable', tenant_id: user.tenant_id, alias: user.alias,
        reason: errorLabel(error) }, 'session authority omitted');
      return undefined;
    }
  }

  /** Reissues the same session with the new `cmp` claim: same sid, CSRF token, issue time and expiry. */
  async switchCompany(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await this.requireCsrf(request);
    const { claims, user } = await this.load(request);
    if (claims.credential_stamp === undefined) throw new AuthorizationError('La sesión debe renovarse para cambiar de empresa.');
    const body: unknown = request.body;
    const fields = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const company = fields.company_id;
    if (Object.keys(fields).length !== 1 || (company !== null && (typeof company !== 'string' || !COMPANY_ID_PATTERN.test(company)))) {
      await reply.code(400).send({ error: 'invalid_request', message: 'Hace falta company_id: un id de empresa o null.' });
      return;
    }
    if (this.companyAuthority === undefined) throw new AuthorizationError('el cambio de empresa no está disponible');
    let authority: ConsoleSessionAuthority;
    try {
      authority = await this.companyAuthority.switchCompany(user, company, claims.cmp);
    } catch (error) {
      if (error instanceof StoreError && error.code === 'forbidden') throw new AuthorizationError('solo un administrador de plataforma cambia de empresa');
      throw error;
    }
    const { cmp: _previous, ...base } = claims;
    const next: ConsoleSessionClaims = authority.platform_override ? { ...base, cmp: authority.acting_company } : base;
    this.requestCache.delete(request);
    await reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', hostSessionCookie(this.cookieName, signConsoleSession(this.signingKey, next),
        claims.exp - this.now() / 1_000, 'Strict'))
      .send(this.sessionState(next, user, authority));
  }

  async updateProfile(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await this.requireCsrf(request);
    const { user } = await this.load(request);
    const body: unknown = request.body;
    const fields = body !== null && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
    const name = typeof fields.name === 'string' ? fields.name.trim() : '';
    if (Object.keys(fields).length !== 1 || name.length === 0 || Array.from(name).length > 120 || name.includes('\0')) {
      await reply.code(400).send({ error: 'invalid_request', message: 'El nombre debe tener entre 1 y 120 caracteres.' });
      return;
    }
    const saved = await this.users.updateDisplayName(user.id, name);
    if (saved === undefined) throw new AuthError('la cuenta de consola no está habilitada');
    await reply.header('Cache-Control', 'no-store').send({ name: saved });
  }

  private issue(user: ConsoleUser, company?: string): { token: string; claims: ConsoleSessionClaims } {
    const issuedAtMs = this.now();
    const claims: ConsoleSessionClaims = {
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      sub: user.id,
      sid: randomUUID(),
      csrf: randomBytes(32).toString('base64url'),
      iat: Math.floor(issuedAtMs / 1_000),
      exp: Math.floor((issuedAtMs + this.sessionTtlMs) / 1_000),
      credential_stamp: createConsoleCredentialStamp(this.signingKey, credentialSnapshot(user)),
      ...(company === undefined ? {} : { cmp: company }),
    };
    return { token: signConsoleSession(this.signingKey, claims), claims };
  }

  async completeDeviceLogin(reply: FastifyReply, grant: {
    humanId: string; tenantId: string; actorAlias: string; activeCompany: string; credentialStamp: string;
  }): Promise<void> {
    const user = await this.users.findById(grant.humanId);
    if (!user?.active || user.tenant_id !== grant.tenantId || user.alias !== grant.actorAlias
        || !this.verifyCredentialStamp(grant.credentialStamp, credentialSnapshot(user))) throw new AuthError('access_denied');
    const authority = await this.companyAuthority?.resolve(user, grant.activeCompany);
    if (authority === undefined || authority.scope === 'none' || authority.acting_company !== grant.activeCompany) {
      throw new AuthError('access_denied');
    }
    await this.sendLogin(reply, user, authority);
  }

  private async sendLogin(reply: FastifyReply, user: ConsoleUser, authority?: ConsoleSessionAuthority): Promise<void> {
    const { token, claims } = this.issue(user, authority?.platform_override ? authority.acting_company : undefined);
    try {
      await this.users.recordLogin(user.id, new Date(this.now()));
    } catch {
      // The last-login marker must not prevent session issuance.
    }
    await reply.header('Cache-Control', 'no-store')
      .header('Set-Cookie', hostSessionCookie(this.cookieName, token, this.sessionTtlMs / 1_000, 'Strict'))
      .code(200).send(this.sessionState(claims, user, authority));
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
    const addressKey = rateLimitKey(request.ip);
    const retryAfterMs = Math.max(this.throttle.retryAfterMs(throttleKey, now), this.addressThrottle.retryAfterMs(addressKey, now, 4));
    if (retryAfterMs > 0) {
      await reply
        .header('Retry-After', String(Math.ceil(retryAfterMs / 1_000)))
        .code(429)
        .send({ error: 'too_many_requests', message: 'Demasiados intentos fallidos. Prueba de nuevo más tarde.' });
      return;
    }
    const releaseEmail = this.throttle.reserve(throttleKey);
    const releaseAddress = this.addressThrottle.reserve(addressKey);
    let user: ConsoleUser | undefined;
    let verified: boolean;
    try {
      user = await this.users.findByEmail(email);
      const hash = user?.password_hash ?? await DECOY_PASSWORD_HASH_PROMISE;
      verified = await passwordWork.run(() => verifyPassword(hash, password), 'login');
    } catch (error) {
      if (!(error instanceof PasswordWorkSaturated)) throw error;
      await reply.header('Retry-After', '5').code(429)
        .send({ error: 'too_many_requests', message: 'Hay demasiados inicios de sesión en curso. Prueba de nuevo en unos segundos.' });
      return;
    } finally {
      releaseEmail(); releaseAddress();
    }
    if (!user || !verified || !user.active) {
      const failedAt = this.now();
      this.throttle.recordFailure(throttleKey, failedAt);
      this.addressThrottle.recordFailure(addressKey, failedAt);
      await reply
        .header('Cache-Control', 'no-store')
        .code(401)
        .send({ error: 'unauthorized', message: CREDENTIAL_FAILURE_MESSAGE });
      return;
    }
    this.throttle.recordSuccess(throttleKey);
    await this.sendLogin(reply, user);
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

function credentialSnapshot(user: ConsoleUser): Readonly<ConsoleCredentialSnapshot> {
  const passwordChangedAtUs = user.password_changed_at_us ?? String(Math.trunc(user.password_changed_at * 1_000));
  return Object.freeze({ userId: user.id, passwordHash: user.password_hash, passwordChangedAtUs });
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
    if (path === '/v3/auth/login' || path === '/v3/auth/register'
        || path === '/v3/auth/device' || path === '/v3/auth/device/token') return;
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
  app.patch('/v3/auth/profile', async (request, reply) => {
    await provider.updateProfile(request, reply);
  });
  app.post('/v3/auth/session/company', async (request, reply) => {
    await provider.switchCompany(request, reply);
  });
  app.post('/v3/auth/logout', async (request, reply) => {
    await provider.logout(request, reply);
  });
}
