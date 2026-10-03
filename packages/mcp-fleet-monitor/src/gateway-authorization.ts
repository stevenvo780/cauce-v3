import { createHash, timingSafeEqual } from 'node:crypto';
import { createOAuthIdentityVerifier, MAX_JWKS_BYTES } from './gateway-oauth-identity.js';
import { httpsOrigin, validBearer, type GatewayAccessConfiguration } from './gateway-configuration.js';

export const MCP_READ_SCOPE = 'cauce.read';
export const MCP_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
export { MAX_JWKS_BYTES };

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
  const issuer = config.issuer;
  const resource = `${origin}/mcp`;
  const verifyIdentity = createOAuthIdentityVerifier(publicOrigin, config);
  return {
    mode: 'oauth' as const,
    challenge: `Bearer resource_metadata="${origin}${MCP_METADATA_PATH}", scope="${MCP_READ_SCOPE}"`,
    metadata: {
      resource, authorization_servers: [issuer], scopes_supported: [MCP_READ_SCOPE],
      bearer_methods_supported: ['header'], resource_name: 'Cauce read-only MCP',
    },
    authenticate: async (authorization: string) => {
      if (!authorization.startsWith('Bearer ') || !validBearer(authorization.slice(7))) return false;
      const identity = await verifyIdentity(authorization.slice(7));
      return identity?.subject === config.subject && identity.scopes.includes(MCP_READ_SCOPE);
    },
  };
}

export type GatewayAuthorization = ReturnType<typeof createGatewayAuthorization>;
