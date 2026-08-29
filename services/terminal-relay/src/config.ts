/**
 * Terminal relay configuration. Everything is a path or a bound: the relay holds no secret
 * of its own beyond the gateway bearer token it reads from disk at call time.
 */

import {
  CLAIM_DEADLINE_SAFETY_MARGIN_MS,
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  MAX_CLAIM_LEASE_MS,
} from './gateway-client.js';
import { isRelayInstanceId } from './relay-identity.js';

export interface TerminalRelayConfig {
  readonly browserPort: number;
  readonly agentPort: number;
  /** Loopback-only HTTP readiness listener; never published by Compose. */
  readonly healthPort: number;
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
   * Client identity the relay uses to talk to the gateway. The shared token authenticates at the
   * application layer, but a gateway with `CAUCE_AUTH_PROVIDER=mtls` demands a client certificate
   * in the TLS handshake itself: without this, presence and authorization recheck die with
   * "tlsv13 alert certificate required" and every session cuts off when grace expires. It is also
   * the cryptographic root of `relay_instance_id`, so there is no mode without this material.
   */
  readonly gatewayClientCertFile: string;
  readonly gatewayClientKeyFile: string;
  /** Release-manifest pin; must equal the digest derived from gatewayClientCertFile. */
  readonly expectedRelayInstanceId: string;
  readonly idleTimeoutMs: number;
  readonly outputRateBytesPerSec: number;
  readonly scrollbackBytes: number;
  readonly maxSessions: number;
  readonly authzIntervalMs: number;
  readonly authzGraceMs: number;
  /** Maximum age of the most recent gateway-accepted presence publication. */
  readonly presenceMaxStaleMs: number;
  /** Nominal gateway lease expected on every grant; checked against the relay fail-closed cycle. */
  readonly expectedClaimLeaseMs: number;
  readonly reconnectGraceMs: number;
  /** Atomic 0600 spool; v2 also carries the raw close fence and therefore must stay capability-private. */
  readonly closeSpoolFile: string;
}

export const DEFAULT_BROWSER_PORT = 8446;
export const DEFAULT_AGENT_PORT = 8445;
export const DEFAULT_HEALTH_PORT = 8085;
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

function relayInstanceId(environment: NodeJS.ProcessEnv): string {
  const value = required(environment, 'CAUCE_TERMINAL_RELAY_INSTANCE_ID');
  if (!isRelayInstanceId(value)) {
    throw new Error('CAUCE_TERMINAL_RELAY_INSTANCE_ID must be 64 lowercase hexadecimal characters');
  }
  return value;
}

export function loadRelayConfig(environment: NodeJS.ProcessEnv = process.env): TerminalRelayConfig {
  const authzIntervalMs = positiveInteger(
    environment, 'CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS', 30,
  ) * 1_000;
  const authzGraceMs = positiveInteger(
    environment, 'CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS', 90,
  ) * 1_000;
  const expectedClaimLeaseMs = positiveInteger(
    environment, 'CAUCE_TERMINAL_CLAIM_LEASE_SECONDS', 150,
  ) * 1_000;
  const requiredClaimLeaseMs = authzIntervalMs + authzGraceMs
    + DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + CLAIM_DEADLINE_SAFETY_MARGIN_MS;
  if (expectedClaimLeaseMs > MAX_CLAIM_LEASE_MS || expectedClaimLeaseMs <= requiredClaimLeaseMs) {
    throw new Error(
      'CAUCE_TERMINAL_CLAIM_LEASE_SECONDS must strictly exceed authz interval, grace, gateway timeout and takeover margin',
    );
  }
  const browserPort = port(environment, 'CAUCE_TERMINAL_RELAY_BROWSER_PORT', DEFAULT_BROWSER_PORT);
  const agentPort = port(environment, 'CAUCE_TERMINAL_RELAY_AGENT_PORT', DEFAULT_AGENT_PORT);
  const healthPort = port(environment, 'CAUCE_TERMINAL_RELAY_HEALTH_PORT', DEFAULT_HEALTH_PORT);
  if (new Set([browserPort, agentPort, healthPort]).size !== 3) {
    throw new Error('terminal relay browser, agent and health ports must be distinct');
  }
  const presenceMaxStaleMs = positiveInteger(
    environment, 'CAUCE_TERMINAL_PRESENCE_MAX_STALE_SECONDS', 30,
  ) * 1_000;
  return {
    browserPort,
    agentPort,
    healthPort,
    tlsCertFile: required(environment, 'CAUCE_TERMINAL_RELAY_TLS_CERT_FILE'),
    tlsKeyFile: required(environment, 'CAUCE_TERMINAL_RELAY_TLS_KEY_FILE'),
    clientCaFile: required(environment, 'CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE'),
    consoleCommonNames: commonNames(environment, 'CAUCE_TERMINAL_RELAY_CONSOLE_CN', 'console'),
    agentCaFile: required(environment, 'CAUCE_TERMINAL_RELAY_AGENT_CA_FILE'),
    agentRegistryFile: environment.CAUCE_TERMINAL_RELAY_AGENT_REGISTRY_FILE ?? DEFAULT_AGENT_REGISTRY_FILE,
    gatewayUrl: gatewayUrl(environment),
    tokenFile: required(environment, 'CAUCE_TERMINAL_RELAY_TOKEN_FILE'),
    gatewayClientCertFile: required(environment, 'CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_FILE'),
    gatewayClientKeyFile: required(environment, 'CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_FILE'),
    expectedRelayInstanceId: relayInstanceId(environment),
    idleTimeoutMs: positiveInteger(environment, 'CAUCE_TERMINAL_IDLE_TIMEOUT_SECONDS', 600) * 1_000,
    outputRateBytesPerSec: positiveInteger(environment, 'CAUCE_TERMINAL_OUTPUT_RATE_BYTES_PER_SEC', 262_144),
    scrollbackBytes: positiveInteger(environment, 'CAUCE_TERMINAL_SCROLLBACK_BYTES', 20_480),
    maxSessions: positiveInteger(environment, 'CAUCE_TERMINAL_MAX_SESSIONS', 16),
    authzIntervalMs,
    authzGraceMs,
    presenceMaxStaleMs,
    expectedClaimLeaseMs,
    reconnectGraceMs: positiveInteger(environment, 'CAUCE_TERMINAL_RECONNECT_GRACE_SECONDS', 30) * 1_000,
    closeSpoolFile: environment.CAUCE_TERMINAL_CLOSE_SPOOL_FILE ?? '/tmp/cauce-terminal-close-reports.json'
  };
}
