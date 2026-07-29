import { readFile } from 'node:fs/promises';
import { AgentLeg, createAgentTlsServer } from './agent-leg.js';
import { BrowserLeg, createBrowserHttpsServer } from './browser-leg.js';
import { loadRelayConfig } from './config.js';
import { HttpsTerminalGatewayClient } from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';
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

// La identidad de cliente hacia el gateway es opcional (sólo hace falta con CAUCE_AUTH_PROVIDER=mtls),
// pero si está configurada se lee ACÁ, al arrancar: así el relay muere de entrada si el material no
// se puede leer, en vez de levantar sano y descubrirlo cuando la primera revalidación no llegue.
const [gatewayClientCert, gatewayClientKey] = await Promise.all([
  config.gatewayClientCertFile === undefined ? undefined : readFile(config.gatewayClientCertFile),
  config.gatewayClientKeyFile === undefined ? undefined : readFile(config.gatewayClientKeyFile)
]);

const gateway = new HttpsTerminalGatewayClient({
  gatewayUrl: config.gatewayUrl,
  tokenFile: config.tokenFile,
  ...(gatewayClientCert === undefined ? {} : { clientCert: gatewayClientCert }),
  ...(gatewayClientKey === undefined ? {} : { clientKey: gatewayClientKey })
});
const sessions = new SessionManager({ gateway, limits: config });

// Presence is republished as soon as the connected set changes, debounced so a fleet-wide
// reconnect is one publish: the console must not show "no PTY agent" for an agent that is up.
let presenceDebounce: NodeJS.Timeout | undefined;
const announcePresence = (): void => {
  if (presenceDebounce !== undefined) return;
  presenceDebounce = setTimeout(() => {
    presenceDebounce = undefined;
    void gateway.publishPresence(agents.presence());
  }, 100);
  presenceDebounce.unref?.();
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
  consoleCommonNames: config.consoleCommonNames,
  gateway,
  agents,
  sessions
});

// A refused handshake is routine on a listener published to the tailnet: log it, never crash.
agentServer.on('tlsClientError', () => logEvent('terminal_relay_agent_handshake_rejected'));
agentServer.on('error', (error: unknown) => logEvent('terminal_relay_agent_server_error', { error: errorLabel(error) }));
browserServer.on('tlsClientError', () => logEvent('terminal_relay_console_handshake_rejected'));
browserServer.on('error', (error: unknown) => logEvent('terminal_relay_browser_server_error', { error: errorLabel(error) }));

agentServer.listen(config.agentPort, '0.0.0.0', () => {
  logEvent('terminal_relay_agent_listening', { port: config.agentPort });
});
browserServer.listen(config.browserPort, '0.0.0.0', () => {
  logEvent('terminal_relay_browser_listening', { port: config.browserPort });
});

// Presence is how the gateway learns which alias has a terminal at all; it is not a heartbeat
// of this process, so a failed publish is logged and retried on the next tick.
const presence = setInterval(() => {
  void gateway.publishPresence(agents.presence());
}, PRESENCE_INTERVAL_MS);
void gateway.publishPresence(agents.presence());

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  logEvent('terminal_relay_stopping', { signal });
  clearInterval(presence);
  if (presenceDebounce !== undefined) clearTimeout(presenceDebounce);
  sessions.closeAll(CLOSE_CODES.going_away, 'relay_shutdown');
  void sessions.flush()
    .then(() => Promise.all([browser.close(), agents.close()]))
    .catch((error: unknown) => logEvent('terminal_relay_shutdown_failed', { error: errorLabel(error) }))
    .finally(() => process.exit(0));
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

// One broken session must never take the process — and every other live terminal — with it.
process.on('uncaughtException', (error: unknown) => {
  logEvent('terminal_relay_uncaught_exception', { error: errorLabel(error) });
});
process.on('unhandledRejection', (reason: unknown) => {
  logEvent('terminal_relay_unhandled_rejection', { error: errorLabel(reason) });
});
