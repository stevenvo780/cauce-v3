import { readFile } from 'node:fs/promises';
import { createServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import {
  decodeDataFrame, decodeJsonFrame, encodeDataFrame, encodeFrame, encodeJsonFrame,
  FrameDecoder, FramingError, FRAME_TAGS, MAX_DATA_BYTES, type Frame
} from './framing.js';
import type { AgentPresence, TerminalMode } from './gateway-client.js';
import { errorLabel, logEvent, shortFingerprint } from './log.js';

/**
 * Agent leg. PTY agents live inside containers on another host (`kratos`) and dial OUT to the
 * relay; the relay never dials in. There is no route from here to a container and creating one
 * would be a privilege escalation, so an agent that is not connected is simply offline.
 *
 * Two independent gates admit an agent: mutual TLS against the agent CA, and a SHA-256
 * fingerprint listed in the identity registry with a matching tenant/alias and a live
 * `expires_at`. A missing or malformed registry admits nobody.
 */

export const AGENT_PING_INTERVAL_MS = 10_000;
export const AGENT_PONG_TIMEOUT_MS = 45_000;
const HELLO_TIMEOUT_MS = 10_000;

export interface AgentIdentity {
  readonly fingerprint_sha256: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly expires_at: string;
}

export interface AgentHello {
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_id: string;
  /** Opaque 32-hex container generation from the launcher; a STRING, never a counter. */
  readonly generation: string;
  readonly image_id: string;
  readonly runtime_user: string;
  readonly runtime_uid: number;
  readonly harness: string;
  readonly agent_version: string;
  readonly modes: readonly TerminalMode[];
}

export interface AgentSessionHandlers {
  onOpenOk(pid: number): void;
  onOpenErr(reason: string): void;
  onStdout(data: Buffer): void;
  onClosed(exit: { readonly exit_code: number | null; readonly signal: string | null; readonly reason: string }): void;
  /** The connection died underneath the session; no CLOSE frame will ever arrive. */
  onAgentGone(reason: string): void;
}

export interface AgentLookup {
  lookup(tenantId: string, alias: string): AgentConnection | undefined;
}

function normalizedFingerprint(value: string): string {
  return value.replace(/:/g, '').toUpperCase();
}

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerField(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function modesField(source: Record<string, unknown>): readonly TerminalMode[] | undefined {
  const value: unknown = source.modes;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const modes: TerminalMode[] = [];
  for (const entry of value as readonly unknown[]) {
    if (entry !== 'shell' && entry !== 'harness') return undefined;
    modes.push(entry);
  }
  return modes;
}

/**
 * Read on every handshake: the file is rotated by atomic rename, so a revoked agent stops
 * being admitted without restarting the relay. Any read or parse failure yields an empty map.
 */
export async function loadAgentRegistry(path: string): Promise<Map<string, AgentIdentity>> {
  const identities = new Map<string, AgentIdentity>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    logEvent('terminal_relay_agent_registry_unreadable', { error: errorLabel(error) });
    return identities;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logEvent('terminal_relay_agent_registry_invalid', { reason: 'not_an_object' });
    return identities;
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.agents)) {
    logEvent('terminal_relay_agent_registry_invalid', { reason: 'unsupported_version' });
    return identities;
  }
  for (const entry of document.agents) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const fingerprint = stringField(record, 'fingerprint_sha256');
    const tenantId = stringField(record, 'tenant_id');
    const alias = stringField(record, 'alias');
    const expiresAt = stringField(record, 'expires_at');
    if (!fingerprint || !tenantId || !alias || !expiresAt || Number.isNaN(Date.parse(expiresAt))) continue;
    identities.set(normalizedFingerprint(fingerprint), {
      fingerprint_sha256: fingerprint,
      tenant_id: tenantId,
      alias,
      expires_at: expiresAt
    });
  }
  return identities;
}

export function parseAgentHello(payload: Buffer): AgentHello | undefined {
  let source: Record<string, unknown>;
  try {
    source = decodeJsonFrame(payload);
  } catch {
    return undefined;
  }
  if (source.v !== 1) return undefined;
  const tenantId = stringField(source, 'tenant_id');
  const alias = stringField(source, 'alias');
  const containerId = stringField(source, 'container_id');
  const imageId = stringField(source, 'image_id');
  const runtimeUser = stringField(source, 'runtime_user');
  const harness = stringField(source, 'harness');
  const agentVersion = stringField(source, 'agent_version');
  const generation = stringField(source, 'generation');
  const runtimeUid = integerField(source, 'runtime_uid');
  const modes = modesField(source);
  if (!tenantId || !alias || !containerId || !imageId || !runtimeUser || !harness || !agentVersion) return undefined;
  if (generation === undefined || runtimeUid === undefined || modes === undefined) return undefined;
  return {
    tenant_id: tenantId,
    alias,
    container_id: containerId,
    generation,
    image_id: imageId,
    runtime_user: runtimeUser,
    runtime_uid: runtimeUid,
    harness,
    agent_version: agentVersion,
    modes
  };
}

/** One live agent socket. Frame routing to sessions lives here so the leg stays a registry. */
export class AgentConnection {
  readonly hello: AgentHello;
  readonly fingerprint: string;
  readonly connectedAt: Date;
  private readonly socket: TLSSocket;
  private readonly sessions = new Map<string, AgentSessionHandlers>();
  private readonly ping: NodeJS.Timeout;
  private lastPongAt: number;
  private paused = false;
  private closed = false;

  constructor(socket: TLSSocket, hello: AgentHello, fingerprint: string, now: () => number) {
    this.socket = socket;
    this.hello = hello;
    this.fingerprint = fingerprint;
    this.connectedAt = new Date(now());
    this.lastPongAt = now();
    this.ping = setInterval(() => {
      if (now() - this.lastPongAt > AGENT_PONG_TIMEOUT_MS) {
        this.destroy('pong_timeout');
        return;
      }
      this.write(encodeFrame(FRAME_TAGS.PING));
    }, AGENT_PING_INTERVAL_MS);
    this.ping.unref?.();
  }

  get key(): string {
    return agentKey(this.hello.tenant_id, this.hello.alias);
  }

  get container(): string {
    return this.hello.container_id;
  }

  get alive(): boolean {
    return !this.closed;
  }

  presence(): AgentPresence {
    return {
      tenant_id: this.hello.tenant_id,
      alias: this.hello.alias,
      container_id: this.hello.container_id,
      generation: this.hello.generation,
      image_id: this.hello.image_id,
      runtime_user: this.hello.runtime_user,
      runtime_uid: this.hello.runtime_uid,
      harness: this.hello.harness,
      agent_version: this.hello.agent_version,
      modes: this.hello.modes,
      connected_since: this.connectedAt.toISOString()
    };
  }

  attachSession(sessionId: string, handlers: AgentSessionHandlers): void {
    this.sessions.set(sessionId, handlers);
  }

  detachSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0) this.resumeOutput();
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sendOpen(sessionId: string, ticket: string, mode: TerminalMode, cols: number, rows: number): void {
    this.write(encodeJsonFrame(FRAME_TAGS.OPEN, { session_id: sessionId, ticket, mode, cols, rows }));
  }

  /** Chunked to the wire limit; the caller may hand us an arbitrarily large paste. */
  sendStdin(sessionId: string, data: Buffer): void {
    for (let offset = 0; offset < data.byteLength; offset += MAX_DATA_BYTES) {
      this.write(encodeDataFrame(FRAME_TAGS.STDIN, sessionId, data.subarray(offset, offset + MAX_DATA_BYTES)));
    }
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    this.write(encodeJsonFrame(FRAME_TAGS.RESIZE, { session_id: sessionId, cols, rows }));
  }

  sendClose(sessionId: string, reason: string): void {
    this.write(encodeJsonFrame(FRAME_TAGS.CLOSE, { session_id: sessionId, reason }));
  }

  /** Backpressure: stop reading the agent socket so the kernel stalls the PTY producer. */
  pauseOutput(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.socket.pause();
  }

  resumeOutput(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.socket.resume();
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    const handlers = [...this.sessions.values()];
    this.sessions.clear();
    this.socket.destroy();
    for (const handler of handlers) {
      try {
        handler.onAgentGone(reason);
      } catch (error) {
        logEvent('terminal_relay_agent_gone_handler_failed', { error: errorLabel(error) });
      }
    }
  }

  /** Called by the leg for every decoded frame after HELLO_ACK. */
  handleFrame(frame: Frame, now: () => number): void {
    if (frame.tag === FRAME_TAGS.PONG) {
      this.lastPongAt = now();
      return;
    }
    if (frame.tag === FRAME_TAGS.STDOUT) {
      const data = decodeDataFrame(frame.payload);
      this.dispatch(data.sessionId, (handlers) => handlers.onStdout(data.data));
      return;
    }
    if (frame.tag === FRAME_TAGS.OPEN_OK) {
      const body = decodeJsonFrame(frame.payload);
      const sessionId = stringField(body, 'session_id');
      if (sessionId === undefined) throw new FramingError('OPEN_OK without a session id');
      const pid = integerField(body, 'pid') ?? 0;
      this.dispatch(sessionId, (handlers) => handlers.onOpenOk(pid));
      return;
    }
    if (frame.tag === FRAME_TAGS.OPEN_ERR) {
      const body = decodeJsonFrame(frame.payload);
      const sessionId = stringField(body, 'session_id');
      if (sessionId === undefined) throw new FramingError('OPEN_ERR without a session id');
      this.dispatch(sessionId, (handlers) => handlers.onOpenErr(stringField(body, 'reason') ?? 'open_failed'));
      return;
    }
    if (frame.tag === FRAME_TAGS.CLOSED) {
      const body = decodeJsonFrame(frame.payload);
      const sessionId = stringField(body, 'session_id');
      if (sessionId === undefined) throw new FramingError('CLOSED without a session id');
      const exitCode = integerField(body, 'exit_code');
      this.dispatch(sessionId, (handlers) => handlers.onClosed({
        exit_code: exitCode === undefined ? null : exitCode,
        signal: stringField(body, 'signal') ?? null,
        reason: stringField(body, 'reason') ?? 'agent_closed'
      }));
      return;
    }
    // AGENT_HELLO after the handshake, or any frame only the relay may send, is a violation.
    throw new FramingError('unexpected frame from the agent');
  }

  private dispatch(sessionId: string, apply: (handlers: AgentSessionHandlers) => void): void {
    const handlers = this.sessions.get(sessionId);
    // Frames for a session we already closed are stale, not fatal: drop them.
    if (!handlers) return;
    try {
      apply(handlers);
    } catch (error) {
      logEvent('terminal_relay_session_handler_failed', { session_id: sessionId, error: errorLabel(error) });
    }
  }

  private write(frame: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(frame);
  }
}

export function agentKey(tenantId: string, alias: string): string {
  return `${tenantId} ${alias}`;
}

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
