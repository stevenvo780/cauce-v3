import { createHash } from 'node:crypto';
import type { OAuthClientMetadata } from './oauth-client-metadata.js';
import type { OAuthClientRegistration, OAuthRegisteredClient } from './oauth-client-registration.js';

export const OAUTH_SCOPES = ['cauce.read', 'cauce.publish'] as const;
export type OAuthScope = typeof OAUTH_SCOPES[number];

export class OAuthError extends Error {
  constructor(readonly error: 'invalid_request' | 'invalid_scope' | 'invalid_client' | 'invalid_grant' | 'access_denied'
    | 'invalid_target' | 'unsupported_grant_type' | 'invalid_redirect_uri' | 'invalid_client_metadata' | 'temporarily_unavailable') {
    super(error);
    this.name = 'OAuthError';
  }
}

export function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function scopes(value: unknown): readonly OAuthScope[] {
  if (typeof value !== 'string' || value.length > 128) throw new OAuthError('invalid_scope');
  const parts = value.split(' ');
  if (!parts.length || parts.some((scope) => !OAUTH_SCOPES.includes(scope as OAuthScope))) {
    throw new OAuthError('invalid_scope');
  }
  return Object.freeze([...new Set(parts)] as OAuthScope[]);
}

export function httpsUrl(value: string, query = false): URL {
  if (value.length > 2048 || /[\s\p{C}]/u.test(value)) throw new OAuthError('invalid_request');
  let url: URL;
  try { url = new URL(value); } catch { throw new OAuthError('invalid_request'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!query && url.search)
      || url.port || url.href !== value) throw new OAuthError('invalid_request');
  return url;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const REDIRECT_RESERVED = ['code', 'state', 'iss', 'error'];

// RFC 8252 §7.3: los clientes nativos reciben el código en http loopback con puerto elegido al vuelo.
export function loopbackRedirect(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

export function redirectUrl(value: string): URL {
  if (value.length > 2048 || /[\s\p{C}]/u.test(value)) throw new OAuthError('invalid_request');
  let url: URL;
  try { url = new URL(value); } catch { throw new OAuthError('invalid_request'); }
  if ((url.protocol !== 'https:' && !loopbackRedirect(url)) || url.username || url.password || url.hash
      || url.href !== value || REDIRECT_RESERVED.some((key) => url.searchParams.has(key))) throw new OAuthError('invalid_request');
  return url;
}

/** Exact match, or a loopback redirect registered without regard to its port (RFC 8252 §7.3). */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let url: URL;
  try { url = redirectUrl(requested); } catch { return false; }
  return loopbackRedirect(url) && registered.some((value) => {
    try {
      const known = redirectUrl(value);
      return loopbackRedirect(known) && known.hostname === url.hostname && known.pathname === url.pathname && known.search === url.search;
    } catch { return false; }
  });
}

export function oauthOrigin(value: string): string {
  const url = httpsUrl(`${value}/`);
  if (url.origin !== value || url.pathname !== '/') throw new OAuthError('invalid_request');
  return value;
}

export interface OAuthPasswordSession {
  readonly userId: string;
  readonly credentialStamp: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly csrf: string;
}

export interface OAuthAuthorizationRequest {
  readonly idHash: string;
  readonly browserHash: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scopes: readonly OAuthScope[];
  readonly challenge: string;
  readonly state: string | null;
}

export interface OAuthAccessIdentity {
  readonly authorizationServer: 'local';
  readonly kind: 'oauth';
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly scopes: readonly OAuthScope[];
  readonly grantId: string;
  readonly tokenId: string;
}

export interface OAuthCodeExchange {
  readonly codeHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly challenge: string;
}

export interface OAuthTokenInput {
  readonly grantId: string;
  readonly userId: string;
  readonly scopes: readonly OAuthScope[];
  readonly expiresAt: number;
}

export interface OAuthIssuedToken {
  readonly token: string;
  readonly identity: OAuthAccessIdentity;
}

export interface OAuthRequestContext {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

export interface OAuthStore {
  createRequest(request: OAuthAuthorizationRequest, context: OAuthRequestContext): Promise<void>;
  request(idHash: string, browserHash: string, context: OAuthRequestContext): Promise<OAuthAuthorizationRequest | undefined>;
  consent(idHash: string, browserHash: string, session: OAuthPasswordSession,
    selected: readonly OAuthScope[] | undefined, context: OAuthRequestContext): Promise<{ code?: string; request: OAuthAuthorizationRequest }>;
  exchange(input: OAuthCodeExchange, issue: (input: OAuthTokenInput) => OAuthIssuedToken, context: OAuthRequestContext): Promise<OAuthIssuedToken>;
  validate(identity: OAuthAccessIdentity): Promise<boolean>;
  revoke(grantId: string, session: OAuthPasswordSession, context: OAuthRequestContext): Promise<void>;
  grants(session: OAuthPasswordSession, context: OAuthRequestContext): Promise<readonly OAuthGrantSummary[]>;
  registerClient(registration: OAuthClientRegistration, context: OAuthRequestContext): Promise<OAuthRegisteredClient>;
  registeredClient(clientId: string, context: OAuthRequestContext): Promise<OAuthClientMetadata | undefined>;
}

export interface OAuthGrantSummary {
  readonly id: string;
  readonly clientId: string;
  readonly scopes: readonly OAuthScope[];
  readonly expiresAt: string;
  readonly revoked: boolean;
}
