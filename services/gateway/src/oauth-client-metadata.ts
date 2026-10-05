import { OAuthError, httpsUrl } from './oauth-authorization-types.js';
import { createOAuthMetadataFetch, type OAuthMetadataFetch } from './oauth-client-fetch.js';

export interface OAuthClientMetadata {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
}

// a single abusive host (many distinct client_id subdomains or paths) is capped on its own so it
// cannot consume the whole process-wide quota; the global cap is raised accordingly so legitimate
// clients spread across other hosts keep working while one host is under attack.
export const OAUTH_CLIENT_HOST_PENDING_CAP = 8;
export const OAUTH_CLIENT_GLOBAL_PENDING_CAP = 128;

export class OAuthClients {
  private readonly cache = new Map<string, { client: OAuthClientMetadata; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<OAuthClientMetadata>>();
  private readonly pendingByHost = new Map<string, number>();
  private readonly fetch: OAuthMetadataFetch;
  private readonly now: () => number;

  constructor(private readonly options: {
    fetch?: OAuthMetadataFetch;
    now?: () => number;
    additionalRedirectOrigins?: readonly string[];
  } = {}) {
    this.fetch = options.fetch ?? createOAuthMetadataFetch();
    this.now = options.now ?? Date.now;
    for (const origin of options.additionalRedirectOrigins ?? []) {
      if (httpsUrl(`${origin}/`).origin !== origin) throw new Error('OAuth redirect origin is invalid');
    }
  }

  async resolve(clientId: string): Promise<OAuthClientMetadata> {
    try {
      const url = httpsUrl(clientId);
      if (url.pathname === '/') throw new OAuthError('invalid_client');
      const cached = this.cache.get(clientId);
      if (cached && cached.expiresAt > this.now()) return cached.client;
      this.cache.delete(clientId);
      const pending = this.pending.get(clientId);
      if (pending) return await pending;
      const host = url.hostname;
      if (this.pending.size >= OAUTH_CLIENT_GLOBAL_PENDING_CAP
          || (this.pendingByHost.get(host) ?? 0) >= OAUTH_CLIENT_HOST_PENDING_CAP) {
        throw new OAuthError('invalid_client');
      }
      this.pendingByHost.set(host, (this.pendingByHost.get(host) ?? 0) + 1);
      const loading = this.load(clientId);
      this.pending.set(clientId, loading);
      try { return await loading; } finally {
        this.pending.delete(clientId);
        const remaining = (this.pendingByHost.get(host) ?? 1) - 1;
        if (remaining > 0) this.pendingByHost.set(host, remaining); else this.pendingByHost.delete(host);
      }
    } catch { throw new OAuthError('invalid_client'); }
  }

  private async load(clientId: string): Promise<OAuthClientMetadata> {
    const response = await this.fetch(clientId);
    if (Buffer.byteLength(response.body) > 16384) throw new OAuthError('invalid_client');
    const value: unknown = JSON.parse(response.body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthError('invalid_client');
    const doc = value as Record<string, unknown>;
    const methods = doc.token_endpoint_auth_methods_supported ?? [doc.token_endpoint_auth_method ?? 'none'];
    const grantTypes = doc.grant_types ?? ['authorization_code'];
    const responseTypes = doc.response_types ?? ['code'];
    if (doc.client_id !== clientId || !Array.isArray(methods) || !methods.includes('none')
        || methods.some((m) => typeof m !== 'string') || !Array.isArray(grantTypes)
        || !grantTypes.includes('authorization_code') || !Array.isArray(responseTypes) || !responseTypes.includes('code')
        || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || doc.redirect_uris.length > 16) {
      throw new OAuthError('invalid_client');
    }
    const origin = new URL(clientId).origin;
    const redirects = doc.redirect_uris.map((value: unknown) => {
      if (typeof value !== 'string') throw new OAuthError('invalid_client');
      const redirect = httpsUrl(value, true);
      if ((redirect.origin !== origin && !this.options.additionalRedirectOrigins?.includes(redirect.origin))
          || ['code', 'state', 'iss', 'error'].some((key) => redirect.searchParams.has(key))) {
        throw new OAuthError('invalid_client');
      }
      return value;
    });
    if (doc.client_name !== undefined && (typeof doc.client_name !== 'string' || doc.client_name.length > 200
        || !doc.client_name.length || /\p{C}/u.test(doc.client_name))) throw new OAuthError('invalid_client');
    const client = Object.freeze({ clientId, clientName: typeof doc.client_name === 'string' ? doc.client_name : origin,
      redirectUris: Object.freeze([...new Set(redirects)]) });
    const control = response.cacheControl ?? '';
    const age = /(?:^|,)\s*max-age\s*=\s*(\d+)(?:\s*(?:,|$))/iu.exec(control)?.[1];
    const ttl = /(?:^|,)\s*(?:no-store|no-cache)(?:\s*(?:,|$))/iu.test(control) ? 0
      : Math.min(300, age === undefined ? 60 : Number(age));
    if (ttl > 0) {
      if (this.cache.size >= 256) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(clientId, { client, expiresAt: this.now() + ttl * 1000 });
    }
    return client;
  }
}
