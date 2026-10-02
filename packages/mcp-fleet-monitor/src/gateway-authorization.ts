import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation } from 'jose';
import { httpsEndpoint, httpsOrigin, validBearer, type GatewayAccessConfiguration } from './gateway-configuration.js';

export const MCP_READ_SCOPE = 'cauce.read';
export const MCP_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
export const MAX_JWKS_BYTES = 64 * 1024;

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

export function createGatewayAuthorization(publicOrigin: string, config: GatewayAccessConfiguration) {
  const origin = httpsOrigin(publicOrigin);
  if (config.mode === 'static') {
    if (!validBearer(config.accessToken, 32)) throw new Error('A valid MCP access token is required');
    const expected = createHash('sha256').update(`Bearer ${config.accessToken}`).digest();
    return {
      mode: 'static' as const,
      challenge: 'Bearer realm="cauce-mcp"',
      metadata: undefined,
      authenticate: async (authorization: string) => timingSafeEqual(expected, createHash('sha256').update(authorization).digest()),
    };
  }
  const issuer = httpsEndpoint(config.issuer);
  const resource = `${origin}/mcp`;
  const keys = createRemoteJWKSet(new URL(httpsEndpoint(config.jwksUri)), {
    timeoutDuration: 3000, cacheMaxAge: 300_000, cooldownDuration: 30_000, [customFetch]: fetchJwks,
  });
  return {
    mode: 'oauth' as const,
    challenge: `Bearer resource_metadata="${origin}${MCP_METADATA_PATH}", scope="${MCP_READ_SCOPE}"`,
    metadata: {
      resource, authorization_servers: [issuer], scopes_supported: [MCP_READ_SCOPE],
      bearer_methods_supported: ['header'], resource_name: 'Cauce read-only MCP',
    },
    authenticate: async (authorization: string) => {
      if (!authorization.startsWith('Bearer ') || !validBearer(authorization.slice(7))) return false;
      try {
        const { payload } = await jwtVerify(authorization.slice(7), keys, {
          issuer, audience: resource, subject: config.subject, typ: 'at+jwt',
          algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'sub'],
        });
        return payload.aud === resource && typeof payload.scope === 'string'
          && payload.scope.split(' ').includes(MCP_READ_SCOPE);
      } catch { return false; }
    },
  };
}

export type GatewayAuthorization = ReturnType<typeof createGatewayAuthorization>;
