import { readFile } from 'node:fs/promises';
import { errorLabel, logEvent } from '@cauce/protocol';
import { AgentLeg, createAgentTlsServer } from './agent-leg.js';
import { BrowserLeg, createBrowserHttpsServer } from './browser-leg.js';
import { loadRelayConfig } from './config.js';
import { HttpsTerminalGatewayClient } from './gateway-client.js';
import { setupGovernanceRelay } from './governance-relay.js';
import { createRelayHealthServer, RelayHealthState } from './health.js';
import { relayProcessIdentity } from './relay-identity.js';
import { CLOSE_CODES, SessionManager } from './sessions.js';

/**
 * Terminal relay entrypoint. The process is the data plane and nothing else: no database, no
 * state on disk, no node-pty, no Docker socket. Restarting it kills terminals and touches
 * nothing else in the bus, which is the whole point of it being a separate service.
 */

const PRESENCE_INTERVAL_MS = 10_000;

// The relay never needs privilege; running as root would be a packaging accident, not a mode.
if (process.getuid?.() === 0) {
  logEvent('terminal_relay_refused', { reason: 'root_euid' });
  process.exit(78);
}

const config = loadRelayConfig();
const [cert, key, clientCa, agentCa] = await Promise.all([
  readFile(config.tlsCertFile),
  readFile(config.tlsKeyFile),
  readFile(config.clientCaFile),
  readFile(config.agentCaFile)
]);

// mTLS identity towards the gateway is part of the multi-relay fence. Read at startup so the
// process fails before publishing readiness if the certificate is missing or cannot be derived.
const [gatewayClientCert, gatewayClientKey] = await Promise.all([
  readFile(config.gatewayClientCertFile),
  readFile(config.gatewayClientKeyFile)
]);
const relayIdentity = relayProcessIdentity(gatewayClientCert);
if (relayIdentity.relayInstanceId !== config.expectedRelayInstanceId) {
  throw new Error('terminal relay mTLS certificate does not match the release-manifest instance id');
}

const gateway = new HttpsTerminalGatewayClient({
  gatewayUrl: config.gatewayUrl,
  tokenFile: config.tokenFile,
  clientCert: gatewayClientCert,
  clientKey: gatewayClientKey,
  identity: relayIdentity,
});
const sessions = new SessionManager({ gateway, limits: config, closeSpoolFile: config.closeSpoolFile });

// Presence is republished as soon as the connected set changes, debounced so a fleet-wide
// reconnect is one publish: the console must not show "no PTY agent" for an agent that is up.
let presenceDebounce: NodeJS.Timeout | undefined;
const presenceState = { publishing: false, pending: false };
const healthState = new RelayHealthState({
  listenersReady: () => agentServer.listening && browserServer.listening,
  presenceMaxStaleMs: config.presenceMaxStaleMs,
});
const hasPendingPresence = (): boolean => presenceState.pending;
const publishPresence = async (): Promise<void> => {
  if (presenceState.publishing) {
    presenceState.pending = true;
    return;
  }
  presenceState.publishing = true;
  try {
    do {
      presenceState.pending = false;
      try {
        await gateway.publishPresence(agents.presence());
        healthState.presenceAccepted();
      } catch {
        healthState.presenceFailed();
      }
    } while (hasPendingPresence());
  } finally {
    presenceState.publishing = false;
  }
};
const announcePresence = (): void => {
  if (presenceDebounce !== undefined) return;
  presenceDebounce = setTimeout(() => {
    presenceDebounce = undefined;
    void publishPresence();
  }, 100);
  presenceDebounce.unref();
};

const agentServer = createAgentTlsServer({ cert, key, ca: agentCa });
const agents = new AgentLeg({
  server: agentServer,
  registryFile: config.agentRegistryFile,
  onChange: announcePresence
});
const browserServer = createBrowserHttpsServer({ cert, key, clientCa });
const browser = new BrowserLeg({
  server: browserServer,
  relayInstanceId: relayIdentity.relayInstanceId,
  consoleCommonNames: config.consoleCommonNames,
  gateway,
  agents,
  sessions
});
const healthServer = createRelayHealthServer(healthState, {
  port: config.healthPort,
  host: '127.0.0.1',
});
// Governance reads share the browser-side listener: it is regular HTTP, not a WebSocket, so it
// coexists with `BrowserLeg` (which only listens on `upgrade`) without colliding. The token is
// the SAME file the relay uses to authenticate against the gateway, just in the opposite
// direction, and it is read on each call so rotating it does not force a restart.
setupGovernanceRelay({
  server: browserServer,
  agents,
  token: async () => (await readFile(config.tokenFile, 'utf8')).trim()
});

// A refused handshake is routine on a listener published to the tailnet: log it, never crash.
agentServer.on('tlsClientError', () => { logEvent('terminal_relay_agent_handshake_rejected'); });
agentServer.on('error', (error: unknown) => { logEvent('terminal_relay_agent_server_error', { error: errorLabel(error) }); });
browserServer.on('tlsClientError', () => { logEvent('terminal_relay_console_handshake_rejected'); });
browserServer.on('error', (error: unknown) => { logEvent('terminal_relay_browser_server_error', { error: errorLabel(error) }); });

agentServer.listen(config.agentPort, '0.0.0.0', () => {
  logEvent('terminal_relay_agent_listening', { port: config.agentPort });
});
browserServer.listen(config.browserPort, '0.0.0.0', () => {
  logEvent('terminal_relay_browser_listening', { port: config.browserPort });
});
healthServer.on('error', (error: unknown) => {
  logEvent('terminal_relay_health_server_error', { error: errorLabel(error) });
});
healthServer.once('listening', () => {
  logEvent('terminal_relay_health_listening', { port: config.healthPort });
});

// Presence is how the gateway learns which alias has a terminal at all; it is not a heartbeat
// of this process, so a failed publish is logged and retried on the next tick.
const presence = setInterval(() => {
  void publishPresence();
}, PRESENCE_INTERVAL_MS);
void publishPresence();

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  healthState.beginShutdown();
  logEvent('terminal_relay_stopping', { signal });
  clearInterval(presence);
  if (presenceDebounce !== undefined) clearTimeout(presenceDebounce);
  sessions.closeAll(CLOSE_CODES.going_away, 'relay_shutdown');
  void sessions.flush()
    .then(() => Promise.all([
      browser.close(),
      agents.close(),
      new Promise<void>((resolve) => healthServer.close(() => { resolve(); })),
    ]))
    .catch((error: unknown) => { logEvent('terminal_relay_shutdown_failed', { error: errorLabel(error) }); })
    .finally(() => process.exit(0));
};
process.once('SIGINT', () => { stop('SIGINT'); });
process.once('SIGTERM', () => { stop('SIGTERM'); });

// One broken session must never take the process — and every other live terminal — with it.
process.on('uncaughtException', (error: unknown) => {
  logEvent('terminal_relay_uncaught_exception', { error: errorLabel(error) });
});
process.on('unhandledRejection', (reason: unknown) => {
  logEvent('terminal_relay_unhandled_rejection', { error: errorLabel(reason) });
});
