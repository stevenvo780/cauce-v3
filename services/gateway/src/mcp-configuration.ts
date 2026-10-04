import { createHumanGatewayAuthorization } from '@cauce/mcp-fleet-monitor/gateway-http';

const configurationError = 'Invalid human MCP OAuth configuration';

export function configuredHumanMcp(environment: NodeJS.ProcessEnv = process.env) {
  const publicOrigin = environment.CAUCE_MCP_PUBLIC_ORIGIN;
  const issuer = environment.CAUCE_MCP_OAUTH_ISSUER;
  const jwksUri = environment.CAUCE_MCP_OAUTH_JWKS_URI;
  if (publicOrigin === undefined && issuer === undefined && jwksUri === undefined) return undefined;
  if (!publicOrigin || !issuer || !jwksUri) throw new Error(configurationError);
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error(configurationError);
  try {
    const authorization = createHumanGatewayAuthorization(publicOrigin, { issuer, jwksUri });
    return {
      publicOrigin: new URL(publicOrigin).origin,
      authorization,
    };
  } catch {
    throw new Error(configurationError);
  }
}
