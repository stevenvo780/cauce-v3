import {
  constants, createHash, createPublicKey, timingSafeEqual, verify as verifySignature,
  type JsonWebKey, type KeyObject, type X509Certificate
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TLSSocket } from 'node:tls';
import type { FastifyRequest } from 'fastify';
import type { Hello, Origin, Tenant } from '@cauce/protocol';
import { AliasSchema, OriginSchema, TenantSchema } from '@cauce/protocol';

export type PrincipalRole = 'agent' | 'operator' | 'adapter';
export type PrincipalPermission = 'route' | 'read' | 'control' | 'notify';

/** Values in this context are authenticated server-side authority, not request metadata. */
export interface Principal {
  readonly tenant_id: Tenant;
  readonly alias: string;
  readonly session_id: string;
  readonly channel: string;
  readonly origin?: Origin;
  readonly roles: readonly PrincipalRole[];
  readonly permissions: readonly PrincipalPermission[];
}

export class AuthError extends Error {
  readonly code = 'unauthorized';

  constructor(message = 'authentication required') {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthorizationError extends Error {
  readonly code = 'forbidden';

  constructor(message = 'insufficient permissions') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export interface AuthProvider {
  readonly name: string;
  readonly mode: 'development' | 'production' | 'test';
  authenticateHttp(request: FastifyRequest): Promise<Principal>;
  authenticateHello(request: FastifyRequest, hello: Hello): Promise<Principal>;
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function nonEmptyString(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new AuthError(`authenticated ${name} claim is invalid`);
  }
  return value;
}

const roles = new Set<PrincipalRole>(['agent', 'operator', 'adapter']);
const permissions = new Set<PrincipalPermission>(['route', 'read', 'control', 'notify']);

function stringSet<T extends string>(value: unknown, allowed: ReadonlySet<T>, name: string): T[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !allowed.has(item as T))) {
    throw new AuthError(`authenticated ${name} claim is invalid`);
  }
  return [...new Set(value as T[])];
}

export function validatePrincipal(value: Principal): Principal {
  const tenant = TenantSchema.safeParse(value.tenant_id);
  const alias = AliasSchema.safeParse(value.alias);
  if (!tenant.success || !alias.success) throw new AuthError('authenticated principal identity is invalid');
  const sessionId = nonEmptyString(value.session_id, 'session_id', 256);
  const channel = nonEmptyString(value.channel, 'channel', 128);
  const principalRoles = stringSet(value.roles, roles, 'roles');
  const principalPermissions = stringSet(value.permissions, permissions, 'permissions');
  const origin = value.origin === undefined ? undefined : OriginSchema.safeParse(value.origin);
  if (origin !== undefined && !origin.success) throw new AuthError('authenticated origin claim is invalid');
  return {
    tenant_id: tenant.data,
    alias: alias.data,
    session_id: sessionId,
    channel,
    roles: principalRoles,
    permissions: principalPermissions,
    ...(origin === undefined ? {} : { origin: origin.data })
  };
}

export function requirePermission(principal: Principal, permission: PrincipalPermission): void {
  if (!principal.permissions.includes(permission)) {
    throw new AuthorizationError(`${permission} permission is required`);
  }
}

export function requireOperator(principal: Principal): void {
  if (!principal.roles.includes('operator')) throw new AuthorizationError('operator role is required');
}

export function requireOperatorPermission(principal: Principal, permission: PrincipalPermission): void {
  requireOperator(principal);
  requirePermission(principal, permission);
}

export class DevOnlyAuthProvider implements AuthProvider {
  readonly name = 'dev-only-headers';
  readonly mode: 'development' | 'test';
  private readonly configuredRoles: readonly PrincipalRole[] | undefined;
  private readonly configuredPermissions: readonly PrincipalPermission[] | undefined;

  constructor(options: {
    enabled: true;
    environment: 'development' | 'test';
    roles?: readonly PrincipalRole[];
    permissions?: readonly PrincipalPermission[];
  }) {
    if (options.enabled !== true) throw new Error('development authentication must be explicitly enabled');
    this.mode = options.environment;
    this.configuredRoles = options.roles;
    this.configuredPermissions = options.permissions;
  }

  static forTests(options: {
    roles?: readonly PrincipalRole[];
    permissions?: readonly PrincipalPermission[];
  } = {}): DevOnlyAuthProvider {
    return new DevOnlyAuthProvider({ enabled: true, environment: 'test', ...options });
  }

  async authenticateHttp(request: FastifyRequest): Promise<Principal> {
    if (process.env.NODE_ENV === 'production') throw new AuthError('development authentication is disabled');
    const tenant = TenantSchema.safeParse(oneHeader(request.headers['x-cauce-tenant']));
    const alias = AliasSchema.safeParse(oneHeader(request.headers['x-cauce-alias']));
    if (!tenant.success || !alias.success) {
      throw new AuthError('dev auth requires x-cauce-tenant and x-cauce-alias');
    }
    const sessionId = `dev:${tenant.data}:${alias.data}`;
    const localOperator = tenant.data === 'Steven' && alias.data === 'kant';
    return validatePrincipal({
      tenant_id: tenant.data,
      alias: alias.data,
      session_id: sessionId,
      channel: 'dev',
      roles: this.configuredRoles ?? (localOperator ? ['operator'] : ['agent']),
      permissions: this.configuredPermissions ?? (localOperator ? ['route', 'read', 'control'] : ['route', 'read']),
      origin: {
        adapter: 'dev-auth',
        channel: 'dev',
        conversation_id: sessionId,
        relay: [],
        metadata: { mode: this.mode }
      }
    });
  }

  async authenticateHello(request: FastifyRequest): Promise<Principal> {
    return this.authenticateHttp(request);
  }
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

export interface JwtClaims extends Record<string, unknown> {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

interface JwksDocument {
  keys: JsonWebKey[];
}

export interface JwksJwtVerifierOptions {
  issuer: string;
  audience: string | readonly string[];
  jwksUrl: string | URL;
  fetcher?: typeof fetch;
  cacheTtlMs?: number;
  clockToleranceSeconds?: number;
  allowedAlgorithms?: readonly ('RS256' | 'PS256' | 'ES256')[];
}

export type JwksJwtAuthProviderOptions = JwksJwtVerifierOptions;

interface CachedJwks {
  expiresAt: number;
  keys: Map<string, { jwk: JsonWebKey; key: KeyObject }>;
}

function decodeJsonPart<T>(part: string, label: string): T {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    throw new AuthError(`malformed JWT ${label}`);
  }
}

function numericDate(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AuthError(`JWT ${name} is invalid`);
  return value;
}

function verifyJwtSignature(algorithm: JwtHeader['alg'], key: KeyObject, input: Buffer, signature: Buffer): boolean {
  if (algorithm === 'RS256') return verifySignature('RSA-SHA256', input, key, signature);
  if (algorithm === 'PS256') {
    return verifySignature('RSA-SHA256', input, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }, signature);
  }
  if (algorithm === 'ES256') {
    return verifySignature('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  return false;
}

/** Signature/issuer/audience verifier shared by bearer and server-side OIDC flows. */
export class JwksJwtVerifier {
  private readonly issuer: string;
  private readonly audiences: ReadonlySet<string>;
  private readonly jwksUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly clockToleranceSeconds: number;
  private readonly allowedAlgorithms: ReadonlySet<string>;
  private cache?: CachedJwks;

  constructor(options: JwksJwtVerifierOptions) {
    this.issuer = options.issuer.replace(/\/$/, '');
    if (this.issuer.length === 0) throw new Error('OIDC issuer is required');
    const configuredAudiences = typeof options.audience === 'string' ? [options.audience] : options.audience;
    if (configuredAudiences.length === 0 || configuredAudiences.some((item) => item.length === 0)) {
      throw new Error('OIDC audience is required');
    }
    this.audiences = new Set(configuredAudiences);
    this.jwksUrl = new URL(options.jwksUrl);
    if (this.jwksUrl.protocol !== 'https:') throw new Error('JWKS URL must use HTTPS');
    this.fetcher = options.fetcher ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 30;
    this.allowedAlgorithms = new Set(options.allowedAlgorithms ?? ['RS256', 'PS256', 'ES256']);
  }

  private async loadKeys(force = false): Promise<CachedJwks> {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) return this.cache;
    let response: Response;
    try {
      response = await this.fetcher(this.jwksUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error'
      });
    } catch {
      throw new AuthError('JWKS endpoint is unavailable');
    }
    if (!response.ok) throw new AuthError('JWKS endpoint rejected the request');
    const document = await response.json() as Partial<JwksDocument>;
    if (!Array.isArray(document.keys)) throw new AuthError('JWKS document is invalid');
    const keys = new Map<string, { jwk: JsonWebKey; key: KeyObject }>();
    for (const jwk of document.keys) {
      if (typeof jwk.kid !== 'string' || jwk.kid.length === 0 || jwk.use === 'enc') continue;
      try {
        keys.set(jwk.kid, { jwk, key: createPublicKey({ key: jwk, format: 'jwk' }) });
      } catch {
        // Ignore keys unsupported by the configured runtime.
      }
    }
    if (keys.size === 0) throw new AuthError('JWKS contains no usable signing key');
    this.cache = { keys, expiresAt: Date.now() + this.cacheTtlMs };
    return this.cache;
  }

  async verify(token: string): Promise<JwtClaims> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new AuthError('malformed bearer token');
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJsonPart<Partial<JwtHeader>>(encodedHeader, 'header');
    if (typeof header.alg !== 'string' || !this.allowedAlgorithms.has(header.alg) || typeof header.kid !== 'string') {
      throw new AuthError('JWT signing header is not allowed');
    }
    if (header.typ !== undefined && !['JWT', 'AT+JWT'].includes(header.typ.toUpperCase())) {
      throw new AuthError('JWT type is invalid');
    }
    let cached = await this.loadKeys();
    let selected = cached.keys.get(header.kid);
    if (!selected) {
      cached = await this.loadKeys(true);
      selected = cached.keys.get(header.kid);
    }
    if (!selected || (selected.jwk.alg !== undefined && selected.jwk.alg !== header.alg)) {
      throw new AuthError('JWT signing key was not found');
    }
    const verified = verifyJwtSignature(
      header.alg,
      selected.key,
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      Buffer.from(encodedSignature, 'base64url')
    );
    if (!verified) throw new AuthError('JWT signature is invalid');
    const claims = decodeJsonPart<JwtClaims>(encodedPayload, 'payload');
    const now = Date.now() / 1_000;
    if (typeof claims.iss !== 'string' || claims.iss.replace(/\/$/, '') !== this.issuer) {
      throw new AuthError('JWT issuer is invalid');
    }
    const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!tokenAudiences.some((item) => typeof item === 'string' && this.audiences.has(item))) {
      throw new AuthError('JWT audience is invalid');
    }
    if (numericDate(claims.exp, 'exp') <= now - this.clockToleranceSeconds) throw new AuthError('JWT is expired');
    if (claims.nbf !== undefined && numericDate(claims.nbf, 'nbf') > now + this.clockToleranceSeconds) {
      throw new AuthError('JWT is not active');
    }
    nonEmptyString(claims.sub, 'subject');
    return claims;
  }

}

export function principalFromJwtClaims(claims: JwtClaims): Principal {
    return validatePrincipal({
      tenant_id: claims.tenant_id as Tenant,
      alias: claims.alias as string,
      session_id: claims.sid as string,
      channel: claims.channel as string,
      roles: claims.roles as PrincipalRole[],
      permissions: claims.permissions as PrincipalPermission[],
      ...(claims.origin === undefined ? {} : { origin: claims.origin as Origin })
    });
}

/** Production bearer provider for non-browser clients. */
export class JwksJwtAuthProvider implements AuthProvider {
  readonly name = 'oidc-jwks';
  readonly mode = 'production' as const;
  private readonly verifier: JwksJwtVerifier;

  constructor(options: JwksJwtAuthProviderOptions) {
    this.verifier = new JwksJwtVerifier(options);
  }

  async verifyToken(token: string): Promise<{ claims: JwtClaims; principal: Principal }> {
    const claims = await this.verifier.verify(token);
    return { claims, principal: principalFromJwtClaims(claims) };
  }

  async authenticateHttp(request: FastifyRequest): Promise<Principal> {
    const authorization = oneHeader(request.headers.authorization);
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) throw new AuthError('bearer token is required');
    return (await this.verifyToken(authorization.slice(7))).principal;
  }

  async authenticateHello(request: FastifyRequest): Promise<Principal> {
    return this.authenticateHttp(request);
  }
}

export interface MtlsIdentityProvider {
  /** Map a certificate already verified by Node TLS to an application principal. */
  resolve(certificate: X509Certificate): Promise<Principal>;
}

/** Production mTLS provider. It never trusts forwarded certificate headers. */
export class MtlsAuthProvider implements AuthProvider {
  readonly name = 'mtls';
  readonly mode = 'production' as const;

  constructor(private readonly identityProvider: MtlsIdentityProvider) {}

  async authenticateHttp(request: FastifyRequest): Promise<Principal> {
    const socket = request.raw.socket;
    if (!(socket instanceof TLSSocket) || !socket.encrypted || !socket.authorized) {
      throw new AuthError('a verified client certificate is required');
    }
    const certificate = socket.getPeerX509Certificate();
    if (!certificate) throw new AuthError('client certificate is missing');
    return validatePrincipal(await this.identityProvider.resolve(certificate));
  }

  async authenticateHello(request: FastifyRequest): Promise<Principal> {
    return this.authenticateHttp(request);
  }
}

interface HashedIdentityRecord {
  token_sha256?: unknown;
  certificate_sha256?: unknown;
  expires_at?: unknown;
  principal?: unknown;
}

interface HashedIdentityDocument {
  version?: unknown;
  identities?: unknown;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function hashBuffer(value: unknown, name: string): Buffer {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new AuthError(`${name} must be a SHA-256 hex digest`);
  }
  return Buffer.from(value, 'hex');
}

function parseExpiry(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AuthError('identity expiry is invalid');
  const expiry = Date.parse(value);
  if (!Number.isFinite(expiry)) throw new AuthError('identity expiry is invalid');
  return expiry;
}

async function readIdentityFile(path: string): Promise<HashedIdentityRecord[]> {
  let decoded: HashedIdentityDocument;
  try {
    decoded = JSON.parse(await readFile(path, 'utf8')) as HashedIdentityDocument;
  } catch {
    throw new AuthError('hashed identity file is unavailable or invalid');
  }
  if (decoded.version !== 1 || !Array.isArray(decoded.identities) || decoded.identities.length === 0) {
    throw new AuthError('hashed identity file is invalid');
  }
  return decoded.identities.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('hashed identity record is invalid');
    return value as HashedIdentityRecord;
  });
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const encoded = matches[0]!.slice(name.length + 1);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export interface HashedTokenFileAuthProviderOptions {
  path: string;
  cookieName?: string;
  allowBearer?: boolean;
}

/**
 * Production pilot provider. The file contains only SHA-256 token digests and principals; raw
 * tokens arrive via an HttpOnly same-origin cookie or adapter Bearer header and are never stored.
 * Every request reloads the file so removal is an immediate, fail-closed revocation mechanism.
 */
export class HashedTokenFileAuthProvider implements AuthProvider {
  readonly name = 'hashed-token-file';
  readonly mode = 'production' as const;
  private readonly cookieName: string;
  private readonly allowBearer: boolean;

  constructor(private readonly options: HashedTokenFileAuthProviderOptions) {
    if (!options.path) throw new Error('hashed token identity file path is required');
    this.cookieName = options.cookieName ?? '__Host-cauce_session';
    if (!/^__Host-[A-Za-z0-9_-]+$/.test(this.cookieName)) {
      throw new Error('token cookie must use the __Host- prefix');
    }
    this.allowBearer = options.allowBearer ?? true;
  }

  async authenticateHttp(request: FastifyRequest): Promise<Principal> {
    const authorization = oneHeader(request.headers.authorization);
    const bearer = this.allowBearer && authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const cookie = cookieValue(oneHeader(request.headers.cookie), this.cookieName);
    if ((bearer ? 1 : 0) + (cookie ? 1 : 0) !== 1) throw new AuthError('exactly one pilot token credential is required');
    const raw = bearer ?? cookie!;
    if (raw.length < 32 || raw.length > 4_096) throw new AuthError('pilot token is invalid');
    const presented = sha256(raw);
    const identities = await readIdentityFile(this.options.path);
    let principal: Principal | undefined;
    for (const identity of identities) {
      if (identity.token_sha256 === undefined) continue;
      const expected = hashBuffer(identity.token_sha256, 'token_sha256');
      if (!timingSafeEqual(presented, expected)) continue;
      const expiry = parseExpiry(identity.expires_at);
      if (expiry !== undefined && expiry <= Date.now()) throw new AuthError('pilot token is expired');
      if (!identity.principal || typeof identity.principal !== 'object') throw new AuthError('pilot principal is invalid');
      if (principal) throw new AuthError('pilot token hash is ambiguous');
      principal = validatePrincipal(identity.principal as Principal);
    }
    presented.fill(0);
    if (!principal) throw new AuthError('pilot token is not recognized');
    return principal;
  }

  async authenticateHello(request: FastifyRequest): Promise<Principal> {
    return this.authenticateHttp(request);
  }
}

/** File-backed mTLS identity mapping by certificate SHA-256 fingerprint; no DN header trust. */
export class HashedMtlsIdentityFileProvider implements MtlsIdentityProvider {
  constructor(private readonly path: string) {
    if (!path) throw new Error('mTLS identity file path is required');
  }

  async resolve(certificate: X509Certificate): Promise<Principal> {
    const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
    const presented = hashBuffer(fingerprint, 'certificate fingerprint');
    const identities = await readIdentityFile(this.path);
    let principal: Principal | undefined;
    for (const identity of identities) {
      if (identity.certificate_sha256 === undefined) continue;
      const expected = hashBuffer(identity.certificate_sha256, 'certificate_sha256');
      if (!timingSafeEqual(presented, expected)) continue;
      const expiry = parseExpiry(identity.expires_at);
      if (expiry !== undefined && expiry <= Date.now()) throw new AuthError('mTLS identity is expired');
      if (!identity.principal || typeof identity.principal !== 'object') throw new AuthError('mTLS principal is invalid');
      if (principal) throw new AuthError('mTLS certificate mapping is ambiguous');
      principal = validatePrincipal(identity.principal as Principal);
    }
    if (!principal) throw new AuthError('mTLS certificate is not provisioned');
    return principal;
  }
}
