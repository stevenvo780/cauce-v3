/**
 * Terminal relay configuration. Everything is a path or a bound: the relay holds no secret
 * of its own beyond the gateway bearer token it reads from disk at call time.
 */

export interface TerminalRelayConfig {
  readonly browserPort: number;
  readonly agentPort: number;
  readonly tlsCertFile: string;
  readonly tlsKeyFile: string;
  /** CA that signs the client certificate of the console nginx in front of the browser leg. */
  readonly clientCaFile: string;
  readonly consoleCommonNames: readonly string[];
  readonly agentCaFile: string;
  readonly agentRegistryFile: string;
  readonly gatewayUrl: string;
  readonly tokenFile: string;
  /**
   * Identidad de cliente con la que el relay habla al gateway. El token compartido autentica en la
   * capa de aplicación, pero un gateway con `CAUCE_AUTH_PROVIDER=mtls` exige certificado de cliente
   * en el propio handshake TLS: sin esto, presencia y revalidación de autorización mueren con
   * "tlsv13 alert certificate required" y toda sesión se corta al vencer la gracia. Opcional para
   * no romper despliegues con otro proveedor de autenticación.
   */
  readonly gatewayClientCertFile: string | undefined;
  readonly gatewayClientKeyFile: string | undefined;
  readonly idleTimeoutMs: number;
  readonly outputRateBytesPerSec: number;
  readonly scrollbackBytes: number;
  readonly maxSessions: number;
  readonly authzIntervalMs: number;
  readonly authzGraceMs: number;
  readonly reconnectGraceMs: number;
  /** Atomic local spool; contains only session ids, reasons and byte counters. */
  readonly closeSpoolFile: string;
}

export const DEFAULT_BROWSER_PORT = 8446;
export const DEFAULT_AGENT_PORT = 8445;
export const DEFAULT_AGENT_REGISTRY_FILE = '/run/cauce-terminal/pty_agent_identities.json';
export const DEFAULT_GATEWAY_URL = 'https://gateway:8443';

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function port(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = positiveInteger(environment, name, fallback);
  if (value > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}

function commonNames(environment: NodeJS.ProcessEnv, name: string, fallback: string): readonly string[] {
  const values = (environment[name] ?? fallback).split(',').map((item) => item.trim());
  if (values.length === 0 || values.some((item) => item.length === 0)) {
    throw new Error(`${name} must contain only non-empty common names`);
  }
  const safeCommonName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (values.some((item) => !safeCommonName.test(item))) {
    throw new Error(`${name} contains an unsafe common name`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${name} must not contain duplicate common names`);
  }
  return values;
}

function gatewayUrl(environment: NodeJS.ProcessEnv): string {
  const value = environment.CAUCE_TERMINAL_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('CAUCE_TERMINAL_GATEWAY_URL must be a credential-free HTTPS origin');
  }
  return url.origin;
}

export function loadRelayConfig(environment: NodeJS.ProcessEnv = process.env): TerminalRelayConfig {
  return {
    browserPort: port(environment, 'CAUCE_TERMINAL_RELAY_BROWSER_PORT', DEFAULT_BROWSER_PORT),
    agentPort: port(environment, 'CAUCE_TERMINAL_RELAY_AGENT_PORT', DEFAULT_AGENT_PORT),
    tlsCertFile: required(environment, 'CAUCE_TERMINAL_RELAY_TLS_CERT_FILE'),
    tlsKeyFile: required(environment, 'CAUCE_TERMINAL_RELAY_TLS_KEY_FILE'),
    clientCaFile: required(environment, 'CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE'),
    consoleCommonNames: commonNames(environment, 'CAUCE_TERMINAL_RELAY_CONSOLE_CN', 'console'),
    agentCaFile: required(environment, 'CAUCE_TERMINAL_RELAY_AGENT_CA_FILE'),
    agentRegistryFile: environment.CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE ?? DEFAULT_AGENT_REGISTRY_FILE,
    gatewayUrl: gatewayUrl(environment),
    tokenFile: required(environment, 'CAUCE_TERMINAL_RELAY_TOKEN_FILE'),
    gatewayClientCertFile: environment.CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE,
    gatewayClientKeyFile: environment.CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE,
    idleTimeoutMs: positiveInteger(environment, 'CAUCE_TERMINAL_IDLE_TIMEOUT_SECONDS', 600) * 1_000,
    outputRateBytesPerSec: positiveInteger(environment, 'CAUCE_TERMINAL_OUTPUT_RATE_BYTES_PER_SEC', 262_144),
    scrollbackBytes: positiveInteger(environment, 'CAUCE_TERMINAL_SCROLLBACK_BYTES', 20_480),
    maxSessions: positiveInteger(environment, 'CAUCE_TERMINAL_MAX_SESSIONS', 16),
    authzIntervalMs: positiveInteger(environment, 'CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS', 30) * 1_000,
    authzGraceMs: positiveInteger(environment, 'CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS', 90) * 1_000,
    reconnectGraceMs: positiveInteger(environment, 'CAUCE_TERMINAL_RECONNECT_GRACE_SECONDS', 30) * 1_000,
    closeSpoolFile: environment.CAUCE_TERMINAL_CLOSE_SPOOL_FILE ?? '/tmp/cauce-terminal-close-reports.json'
  };
}
