import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation } from 'jose';
import { httpsEndpoint, httpsOrigin, validBearer } from './gateway-configuration.js';

export const MAX_JWKS_BYTES = 64 * 1024;

export interface VerifiedOAuthIdentity {
  readonly kind: 'oauth';
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly authorizationServer?: 'local';
  readonly grantId?: string;
  readonly tokenId?: string;
}

export interface OAuthIdentityVerifierConfiguration {
  readonly issuer: string;
  readonly jwksUri: string;
}

const fetchJwks: FetchImplementation = async (url, options) => {
  const response = await fetch(url, { ...options, redirect: 'error', credentials: 'omit' });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error('JWKS unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_JWKS_BYTES) throw new Error('JWKS too large');
      chunks.push(chunk.value);
    }
    return new Response(Buffer.concat(chunks).toString('utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
  } finally { await reader.cancel(); }
};

function parseScopes(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === '') return Object.freeze([]);
  if (typeof value !== 'string') return undefined;
  const tokens = value.split(' ');
  if (tokens.some((token) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/u.test(token))) return undefined;
  return Object.freeze([...new Set(tokens)]);
}

export function createOAuthIdentityVerifier(publicOrigin: string, config: OAuthIdentityVerifierConfiguration) {
  const issuer = httpsEndpoint(config.issuer);
  const jwksUri = httpsEndpoint(config.jwksUri);
  const audience = `${httpsOrigin(publicOrigin)}/mcp`;
  const keys = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: 3000, cacheMaxAge: 300_000, cooldownDuration: 30_000, [customFetch]: fetchJwks,
  });

  return async (token: string): Promise<VerifiedOAuthIdentity | undefined> => {
    if (!validBearer(token)) return undefined;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer, audience, typ: 'at+jwt', algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'sub'],
      });
      if (payload.iss !== issuer || payload.aud !== audience || typeof payload.sub !== 'string'
        || payload.sub.length === 0 || payload.sub.length > 256 || /\p{C}/u.test(payload.sub)
        || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return undefined;
      const scopes = parseScopes(payload.scope);
      if (!scopes) return undefined;
      return Object.freeze({
        kind: 'oauth' as const, issuer, subject: payload.sub, audience,
        expiresAt: payload.exp, scopes,
      });
    } catch { return undefined; }
  };
}
