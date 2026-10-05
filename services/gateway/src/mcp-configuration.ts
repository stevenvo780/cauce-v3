import { createHumanGatewayAuthorization, type HumanGatewayAuthorization } from '@cauce/mcp-fleet-monitor/gateway-http';

import { createLocalOAuthAuthorization } from './oauth-grant-authority.js';
import type { OAuthAuthorizationServerOptions } from './oauth-authorization-server.js';

export interface HumanMcpConfiguration {
  publicOrigin: string;
  authorization: HumanGatewayAuthorization;
  oauth?: OAuthAuthorizationServerOptions;
}

const configurationError = 'Invalid human MCP OAuth configuration';

export function configuredHumanMcp(environment: NodeJS.ProcessEnv = process.env, local?: OAuthAuthorizationServerOptions,
): HumanMcpConfiguration | undefined {
  const provider = environment.CAUCE_MCP_OAUTH_PROVIDER;
  if (provider !== undefined && provider !== 'local') throw new Error(configurationError);
  if (provider === 'local') {
    if (!local || environment.NODE_TLS_REJECT_UNAUTHORIZED === '0'
        || environment.CAUCE_MCP_PUBLIC_ORIGIN !== local.tokens.issuer
        || (environment.CAUCE_MCP_OAUTH_ISSUER !== undefined && environment.CAUCE_MCP_OAUTH_ISSUER !== local.tokens.issuer)
        || environment.CAUCE_MCP_OAUTH_JWKS_URI !== undefined) throw new Error(configurationError);
    return { publicOrigin: local.tokens.issuer, authorization: createLocalOAuthAuthorization(local.tokens, local.store), oauth: local };
  }
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
