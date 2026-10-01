import { TenantSchema } from '@cauce/protocol';

export interface GatewayConfiguration {
  readonly origin: string;
  readonly tenant: string;
  readonly bearerToken?: string;
  readonly caFile?: string;
  readonly certificateFile?: string;
  readonly keyFile?: string;
}

export interface GatewayBridgeConfiguration {
  readonly gateway: GatewayConfiguration;
  readonly publicOrigin: string;
  readonly authentication: GatewayAccessConfiguration;
  readonly port: number;
}

export type GatewayAccessConfiguration =
  | { readonly mode: 'static'; readonly accessToken: string }
  | { readonly mode: 'oauth'; readonly issuer: string; readonly jwksUri: string; readonly subject: string };

type Environment = Readonly<Record<string, string | undefined>>;

export function httpsOrigin(value: string | undefined): string {
  try {
    if (!value?.length || value.trim() !== value) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash
      || ![url.origin, `${url.origin}/`].includes(value)) throw new Error();
    return url.origin;
  } catch {
    throw new Error('A canonical HTTPS origin without path, query or credentials is required');
  }
}

export function validBearer(value: string, minLength = 1): boolean {
  return value.length >= minLength && value.length <= 8192 && /^[A-Za-z0-9._~+/-]+=*$/u.test(value);
}

export function httpsEndpoint(value: string | undefined): string {
  try {
    if (!value?.length || value.trim() !== value) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.href !== value && url.href !== `${value}/`)) throw new Error();
    return value;
  } catch { throw new Error('A canonical HTTPS endpoint without query or credentials is required'); }
}

function accessConfiguration(env: Environment): GatewayAccessConfiguration {
  const mode = env.CAUCE_MCP_AUTH_MODE ?? 'oauth';
  if (mode === 'static') {
    const accessToken = env.CAUCE_MCP_ACCESS_TOKEN ?? '';
    if (!validBearer(accessToken, 32)) throw new Error('CAUCE_MCP_ACCESS_TOKEN must be a distinct token of at least 32 characters');
    return { mode, accessToken };
  }
  if (mode !== 'oauth') throw new Error('CAUCE_MCP_AUTH_MODE must be oauth or static');
  const issuer = httpsEndpoint(env.CAUCE_MCP_OAUTH_ISSUER);
  const jwksUri = httpsEndpoint(env.CAUCE_MCP_OAUTH_JWKS_URI);
  const subject = env.CAUCE_MCP_OAUTH_SUBJECT;
  if (!subject || subject.length > 256 || /\p{C}/u.test(subject)) throw new Error('CAUCE_MCP_OAUTH_SUBJECT must identify the authorized user');
  return { mode, issuer, jwksUri, subject };
}

export function gatewayBridgeConfiguration(env: Environment = process.env): GatewayBridgeConfiguration {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled');
  const origin = httpsOrigin(env.CAUCE_GATEWAY_ORIGIN);
  const publicOrigin = httpsOrigin(env.CAUCE_MCP_PUBLIC_ORIGIN);
  const tenant = TenantSchema.safeParse(env.CAUCE_MCP_TENANT_ID);
  if (!tenant.success) throw new Error('CAUCE_MCP_TENANT_ID is required and must be valid');
  const authentication = accessConfiguration(env);
  const bearerToken = env.CAUCE_GATEWAY_BEARER_TOKEN;
  const certificateFile = env.CAUCE_GATEWAY_CERT_FILE;
  const keyFile = env.CAUCE_GATEWAY_KEY_FILE;
  const caFile = env.CAUCE_GATEWAY_CA_FILE;
  if (bearerToken !== undefined && (!validBearer(bearerToken)
    || (authentication.mode === 'static' && bearerToken === authentication.accessToken))) {
    throw new Error('The gateway bearer token must be valid and different from the MCP access token');
  }
  if (Boolean(certificateFile) !== Boolean(keyFile)) throw new Error('Gateway mTLS requires both certificate and key files');
  if (!bearerToken && !certificateFile) throw new Error('Gateway bearer or mTLS authentication is required');
  if ([caFile, certificateFile, keyFile].some((path) => path !== undefined && (!path.startsWith('/') || path.includes('\0')))) {
    throw new Error('Gateway TLS file paths must be absolute');
  }
  const portText = env.CAUCE_MCP_PORT ?? '3101';
  const port = Number(portText);
  if (!/^[0-9]+$/u.test(portText) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('CAUCE_MCP_PORT must be an integer between 1024 and 65535');
  }
  return {
    publicOrigin, authentication, port,
    gateway: {
      origin, tenant: tenant.data,
      ...(bearerToken === undefined ? {} : { bearerToken }),
      ...(caFile === undefined ? {} : { caFile }),
      ...(certificateFile === undefined ? {} : { certificateFile }),
      ...(keyFile === undefined ? {} : { keyFile }),
    },
  };
}
