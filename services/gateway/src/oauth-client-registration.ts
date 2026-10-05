import { isAnyUuid } from '@cauce/protocol';
import { OAuthError, redirectUrl } from './oauth-authorization-types.js';

export const REGISTERED_CLIENT_PREFIX = 'cauce-dcr-';
export const UNNAMED_REGISTERED_CLIENT = 'Cliente MCP sin nombre';
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
type RegisteredGrantType = typeof GRANT_TYPES[number];

export interface OAuthClientRegistration {
  readonly clientName: string | null;
  readonly redirectUris: readonly string[];
  readonly grantTypes: readonly RegisteredGrantType[];
}

export interface OAuthRegisteredClient extends OAuthClientRegistration {
  readonly clientId: string;
  readonly issuedAt: number;
}

export function isRegisteredClientId(value: string): boolean {
  return value.startsWith(REGISTERED_CLIENT_PREFIX) && isAnyUuid(value.slice(REGISTERED_CLIENT_PREFIX.length));
}

function strings(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= max && value.every((entry) => typeof entry === 'string');
}

function clientName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 1000) throw new OAuthError('invalid_client_metadata');
  // Nombre declarado por el cliente: sin controles ni bidi, espacios plegados y acotado para la pantalla.
  const name = value.replace(/\p{C}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 100).trim();
  return name.length ? name : null;
}

/**
 * RFC 7591 for public clients only. Unknown metadata is ignored (§2); only the fields Cauce enforces are kept.
 * An omitted token_endpoint_auth_method registers as `none`, because this server issues no client secrets.
 */
export function clientRegistration(value: unknown): OAuthClientRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthError('invalid_client_metadata');
  const doc = value as Record<string, unknown>;
  const method = doc.token_endpoint_auth_method ?? 'none';
  const grantTypes = doc.grant_types ?? ['authorization_code'];
  const responseTypes = doc.response_types ?? ['code'];
  if (method !== 'none' || !strings(grantTypes, 4) || !grantTypes.includes('authorization_code')
      || grantTypes.some((grant) => !(GRANT_TYPES as readonly string[]).includes(grant))
      || !strings(responseTypes, 4) || responseTypes.some((type) => type !== 'code')) {
    throw new OAuthError('invalid_client_metadata');
  }
  if (!strings(doc.redirect_uris, 10)) throw new OAuthError('invalid_redirect_uri');
  for (const redirect of doc.redirect_uris) {
    try { redirectUrl(redirect); } catch { throw new OAuthError('invalid_redirect_uri'); }
  }
  return Object.freeze({ clientName: clientName(doc.client_name),
    redirectUris: Object.freeze([...new Set(doc.redirect_uris)]),
    grantTypes: Object.freeze([...new Set(grantTypes)] as RegisteredGrantType[]) });
}

export function registrationDocument(client: OAuthRegisteredClient) {
  return { client_id: client.clientId, client_id_issued_at: client.issuedAt,
    ...(client.clientName === null ? {} : { client_name: client.clientName }),
    redirect_uris: [...client.redirectUris], grant_types: [...client.grantTypes], response_types: ['code'],
    token_endpoint_auth_method: 'none' };
}

/**
 * Token bucket per key; bounded so a key flood cannot grow it without limit. The gateway keys it globally
 * (60 registrations, one more every 2 s): behind nginx/Caddy request.ip is the proxy, so per-address limiting
 * belongs at the edge and the durable cap in the store bounds what gets through.
 */
export class OAuthRegistrationLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly refillMs: number;
  private readonly now: () => number;

  constructor(options: { capacity?: number; refillMs?: number; now?: () => number } = {}) {
    this.capacity = options.capacity ?? 60;
    this.refillMs = options.refillMs ?? 2_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || !Number.isSafeInteger(this.refillMs) || this.refillMs < 1) {
      throw new Error('OAuth registration limit is invalid');
    }
  }

  get retryAfterSeconds(): number { return Math.ceil(this.refillMs / 1000); }

  take(key: string): boolean {
    const now = this.now();
    const current = this.buckets.get(key);
    const tokens = current === undefined ? this.capacity
      : Math.min(this.capacity, current.tokens + Math.max(0, now - current.at) / this.refillMs);
    this.buckets.delete(key);
    if (this.buckets.size >= 4096) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    const allowed = tokens >= 1;
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at: now });
    return allowed;
  }
}
