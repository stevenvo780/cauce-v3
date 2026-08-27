import { createServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import { AgentConnection } from './agent-connection.js';
import {
  HELLO_TIMEOUT_MS,
  agentKey,
  loadAgentRegistry,
  normalizedFingerprint,
  parseAgentHello,
  type AgentIdentity,
  type AgentLookup,
} from './agent-hello.js';
import {
  FrameDecoder,
  FramingError,
  FRAME_TAGS,
  encodeJsonFrame,
  type Frame,
} from './framing.js';
import type { AgentPresence } from './gateway-client.js';
import { errorLabel, logEvent, shortFingerprint } from './log.js';

export * from './agent-hello.js';
export * from './agent-connection.js';

export interface AgentTlsMaterial {
  readonly cert: Buffer | string;
  readonly key: Buffer | string;
  readonly ca: Buffer | string;
}

/**
 * The agent listener always demands and verifies a client certificate. This factory exists so
 * that no caller — production wiring or test — can accidentally stand up an anonymous listener.
 */
export function createAgentTlsServer(material: AgentTlsMaterial): TlsServer {
  return createServer({
    cert: material.cert,
    key: material.key,
    ca: material.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'
  });
}

export interface AgentLegOptions {
  readonly server: TlsServer;
  readonly registryFile: string;
  readonly now?: () => number;
  /** Fired when an agent connects or drops, so presence can be published without waiting a tick. */
  readonly onChange?: () => void;
}

export class AgentLeg implements AgentLookup {
  private readonly server: TlsServer;
  private readonly registryFile: string;
  private readonly now: () => number;
  private readonly onChange: (() => void) | undefined;
  private readonly connections = new Map<string, AgentConnection>();

  constructor(options: AgentLegOptions) {
    this.server = options.server;
    this.registryFile = options.registryFile;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
    this.server.on('secureConnection', (socket) => {
      void this.accept(socket);
    });
  }

  lookup(tenantId: string, alias: string): AgentConnection | undefined {
    const connection = this.connections.get(agentKey(tenantId, alias));
    return connection?.alive === true ? connection : undefined;
  }

  presence(): AgentPresence[] {
    return [...this.connections.values()].filter((connection) => connection.alive).map((connection) => connection.presence());
  }

  async close(): Promise<void> {
    for (const connection of [...this.connections.values()]) connection.destroy('relay_shutdown');
    this.connections.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async accept(socket: TLSSocket): Promise<void> {
    socket.on('error', () => socket.destroy());
    const certificate = socket.getPeerCertificate();
    const fingerprint = typeof certificate.fingerprint256 === 'string' ? certificate.fingerprint256 : '';
    if (!socket.authorized || fingerprint === '') {
      logEvent('terminal_relay_agent_rejected', { reason: 'unverified_certificate' });
      socket.destroy();
      return;
    }
    const registry = await loadAgentRegistry(this.registryFile);
    const identity = registry.get(normalizedFingerprint(fingerprint));
    if (!identity) {
      logEvent('terminal_relay_agent_rejected', { reason: 'unknown_fingerprint', fingerprint: shortFingerprint(fingerprint) });
      socket.destroy();
      return;
    }
    if (Date.parse(identity.expires_at) <= this.now()) {
      logEvent('terminal_relay_agent_rejected', {
        reason: 'identity_expired', alias: identity.alias, fingerprint: shortFingerprint(fingerprint)
      });
      socket.destroy();
      return;
    }
    this.readFrames(socket, identity, fingerprint);
  }

  private readFrames(socket: TLSSocket, identity: AgentIdentity, fingerprint: string): void {
    const decoder = new FrameDecoder();
    let connection: AgentConnection | undefined;
    const hello = setTimeout(() => {
      if (!connection) socket.destroy();
    }, HELLO_TIMEOUT_MS);
    hello.unref?.();
    const fail = (reason: string): void => {
      clearTimeout(hello);
      logEvent('terminal_relay_agent_rejected', { reason, alias: identity.alias, fingerprint: shortFingerprint(fingerprint) });
      if (connection) connection.destroy(reason);
      else socket.destroy();
    };
    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        fail(error instanceof FramingError ? 'framing_violation' : 'decode_failed');
        return;
      }
      for (const frame of frames) {
        try {
          if (!connection) {
            if (frame.tag !== FRAME_TAGS.AGENT_HELLO) {
              fail('hello_expected');
              return;
            }
            connection = this.admit(socket, frame, identity, fingerprint);
            if (!connection) return;
            clearTimeout(hello);
            continue;
          }
          connection.handleFrame(frame, this.now);
        } catch (error) {
          logEvent('terminal_relay_agent_frame_failed', { alias: identity.alias, error: errorLabel(error) });
          fail('frame_failed');
          return;
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(hello);
      if (!connection) return;
      const current = this.connections.get(connection.key);
      if (current === connection) this.connections.delete(connection.key);
      connection.destroy('agent_disconnected');
      logEvent('terminal_relay_agent_disconnected', { tenant_id: identity.tenant_id, alias: identity.alias });
      this.announce();
    });
  }

  private admit(socket: TLSSocket, frame: Frame, identity: AgentIdentity, fingerprint: string): AgentConnection | undefined {
    const hello = parseAgentHello(frame.payload);
    if (!hello) {
      socket.write(encodeJsonFrame(FRAME_TAGS.HELLO_ACK, { ok: false, reason: 'invalid_hello' }));
      logEvent('terminal_relay_agent_rejected', { reason: 'invalid_hello', fingerprint: shortFingerprint(fingerprint) });
      socket.destroy();
      return undefined;
    }
    // The certificate names the agent; the hello only restates it. A mismatch is an attempt to
    // borrow another alias' identity, so it never gets a session.
    if (hello.tenant_id !== identity.tenant_id || hello.alias !== identity.alias) {
      socket.write(encodeJsonFrame(FRAME_TAGS.HELLO_ACK, { ok: false, reason: 'identity_mismatch' }));
      logEvent('terminal_relay_agent_rejected', {
        reason: 'identity_mismatch', alias: identity.alias, fingerprint: shortFingerprint(fingerprint)
      });
      socket.destroy();
      return undefined;
    }
    const connection = new AgentConnection(socket, hello, fingerprint, this.now);
    const previous = this.connections.get(connection.key);
    if (previous && previous !== connection) previous.destroy('superseded');
    this.connections.set(connection.key, connection);
    socket.write(encodeJsonFrame(FRAME_TAGS.HELLO_ACK, { ok: true }));
    logEvent('terminal_relay_agent_connected', {
      tenant_id: hello.tenant_id,
      alias: hello.alias,
      container_id: hello.container_id,
      generation: hello.generation,
      runtime_user: hello.runtime_user,
      fingerprint: shortFingerprint(fingerprint)
    });
    this.announce();
    return connection;
  }

  private announce(): void {
    try {
      this.onChange?.();
    } catch (error) {
      logEvent('terminal_relay_presence_change_failed', { error: errorLabel(error) });
    }
  }
}
