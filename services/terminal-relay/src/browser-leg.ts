import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AgentLookup } from './agent-leg.js';
import { isSessionId } from './framing.js';
import type { TerminalGatewayClient } from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';
import {
  clampTerminalGeometry, CLOSE_CODES, MAX_EARLY_CLIENT_BYTES, rawDataByteLength, rawText,
  SessionManager, type QueuedClientMessage
} from './sessions.js';

/**
 * Browser leg. The browser never reaches this listener: the console nginx terminates the user
 * connection and re-dials with a client certificate, so the only thing admitted here is a
 * verified console CN. Ticket verification is not done here either — the relay has no key and
 * asks the gateway to consume the ticket instead.
 */

export const BROWSER_WS_PATH = '/v3/console/terminal/ws';
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000;
/** Frames tolerated between attach and ready; a client flooding the gap is not typing. */
const MAX_QUEUED_MESSAGES = 32;
const WS_OPEN = 1;

export interface InitialAttachRequest {
  readonly type: 'attach';
  readonly session_id: string;
  readonly ticket: string;
  readonly cols: number;
  readonly rows: number;
}

export interface ResumeAttachRequest {
  readonly type: 'resume';
  readonly session_id: string;
  readonly resume_token: string;
  readonly after_bytes: number;
  readonly cols: number;
  readonly rows: number;
}

export type AttachRequest = InitialAttachRequest | ResumeAttachRequest;

/** The first frame is text JSON or the connection is not ours. */
export function parseAttachRequest(data: RawData, isBinary: boolean): AttachRequest | undefined {
  if (isBinary) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText(data));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const source = parsed as Record<string, unknown>;
  if (source.type !== 'attach' && source.type !== 'resume') return undefined;
  const sessionId = source.session_id;
  if (typeof sessionId !== 'string' || !isSessionId(sessionId)) return undefined;
  const geometry = clampTerminalGeometry(source.cols, source.rows);
  if (geometry === undefined) return undefined;
  if (source.type === 'attach') {
    const ticket = source.ticket;
    if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 4_096) return undefined;
    return { type: 'attach', session_id: sessionId, ticket, ...geometry };
  }
  const resumeToken = source.resume_token;
  const afterBytes = source.after_bytes;
  if (typeof resumeToken !== 'string' || resumeToken.length < 80 || resumeToken.length > 1_024 ||
      typeof afterBytes !== 'number' || !Number.isSafeInteger(afterBytes) || afterBytes < 0) return undefined;
  return {
    type: 'resume', session_id: sessionId, resume_token: resumeToken, after_bytes: afterBytes, ...geometry
  };
}

export interface BrowserTlsMaterial {
  readonly cert: Buffer | string;
  readonly key: Buffer | string;
  /** CA of the console nginx client certificate. */
  readonly clientCa: Buffer | string;
}

/**
 * The browser listener always demands and verifies a client certificate, exactly like the
 * agent listener. Standing one up without mutual TLS is not reachable through this module.
 */
export function createBrowserHttpsServer(material: BrowserTlsMaterial): HttpsServer {
  return createHttpsServer({
    cert: material.cert,
    key: material.key,
    ca: material.clientCa,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'
  });
}

/** Common name of the verified peer, or undefined when the transport is not trusted mTLS. */
export function consoleCommonName(socket: Duplex): string | undefined {
  if (!(socket instanceof TLSSocket) || !socket.authorized) return undefined;
  const subject: unknown = socket.getPeerCertificate().subject;
  if (subject === null || typeof subject !== 'object') return undefined;
  const commonName = (subject as Record<string, unknown>).CN;
  return typeof commonName === 'string' && commonName.length > 0 ? commonName : undefined;
}

export interface BrowserLegOptions {
  readonly server: HttpsServer;
  readonly consoleCommonNames: readonly string[];
  readonly gateway: TerminalGatewayClient;
  readonly agents: AgentLookup;
  readonly sessions: SessionManager;
  readonly attachTimeoutMs?: number;
  readonly maxConnections?: number;
  readonly maxAttachAttemptsPerSecond?: number;
}

function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && parsed.host === host && parsed.username === '' && parsed.password === '' &&
      parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

export class BrowserLeg {
  private readonly server: HttpsServer;
  private readonly consoleCommonNames: ReadonlySet<string>;
  private readonly gateway: TerminalGatewayClient;
  private readonly agents: AgentLookup;
  private readonly sessions: SessionManager;
  private readonly attachTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly maxAttachAttemptsPerSecond: number;
  private readonly wss: WebSocketServer;
  private attachWindowStartedAt = 0;
  private attachAttempts = 0;

  constructor(options: BrowserLegOptions) {
    this.server = options.server;
    this.consoleCommonNames = new Set(options.consoleCommonNames);
    this.gateway = options.gateway;
    this.agents = options.agents;
    this.sessions = options.sessions;
    this.attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
    this.maxConnections = options.maxConnections ?? 64;
    this.maxAttachAttemptsPerSecond = options.maxAttachAttemptsPerSecond ?? 32;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.server.on('upgrade', (request, socket, head) => {
      const path = (request.url ?? '/').split('?', 1)[0];
      if (path !== BROWSER_WS_PATH) {
        socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!isSameOrigin(request.headers.origin, request.headers.host)) {
        logEvent('terminal_relay_console_rejected', { reason: 'origin_mismatch' });
        socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      const commonName = consoleCommonName(socket);
      if (commonName === undefined || !this.consoleCommonNames.has(commonName)) {
        logEvent('terminal_relay_console_rejected', { reason: 'untrusted_client_certificate' });
        socket.destroy();
        return;
      }
      if (this.wss.clients.size >= this.maxConnections) {
        logEvent('terminal_relay_console_rejected', { reason: 'connection_limit' });
        socket.write('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (client) => {
        this.onConnection(client, commonName);
      });
    });
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.close(CLOSE_CODES.going_away, 'relay_shutdown');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(socket: WebSocket, commonName: string): void {
    let attached = false;
    let gone = false;
    let queuedBytes = 0;
    const queued: QueuedClientMessage[] = [];
    const attachTimer = setTimeout(() => {
      if (!attached) {
        logEvent('terminal_relay_attach_rejected', { reason: 'attach_timeout', console_cn: commonName });
        socket.close(CLOSE_CODES.protocol_error, 'attach_timeout');
      }
    }, this.attachTimeoutMs);
    attachTimer.unref?.();
    socket.once('close', () => {
      gone = true;
      clearTimeout(attachTimer);
    });
    socket.on('error', () => socket.terminate());
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (attached) {
        const bytes = rawDataByteLength(data);
        if (queued.length >= MAX_QUEUED_MESSAGES || queuedBytes + bytes > MAX_EARLY_CLIENT_BYTES) {
          socket.close(CLOSE_CODES.input_flood, 'input_flood');
          return;
        }
        queued.push({ data, isBinary });
        queuedBytes += bytes;
        return;
      }
      if (!this.takeAttachAttempt()) {
        logEvent('terminal_relay_attach_rejected', { reason: 'attach_rate_limit', console_cn: commonName });
        socket.close(CLOSE_CODES.session_conflict, 'attach_rate_limit');
        return;
      }
      attached = true;
      clearTimeout(attachTimer);
      const attach = parseAttachRequest(data, isBinary);
      if (!attach) {
        logEvent('terminal_relay_attach_rejected', { reason: 'protocol_error', console_cn: commonName });
        socket.close(CLOSE_CODES.protocol_error, 'protocol_error');
        return;
      }
      void this.attach(socket, attach, queued, () => gone, onMessage);
    };
    socket.on('message', onMessage);
  }

  private takeAttachAttempt(now = Date.now()): boolean {
    if (now - this.attachWindowStartedAt >= 1_000) {
      this.attachWindowStartedAt = now;
      this.attachAttempts = 0;
    }
    this.attachAttempts += 1;
    return this.attachAttempts <= this.maxAttachAttemptsPerSecond;
  }

  private async attach(
    socket: WebSocket,
    attach: AttachRequest,
    queued: QueuedClientMessage[],
    gone: () => boolean,
    onMessage: (data: RawData, isBinary: boolean) => void
  ): Promise<void> {
    let ticketConsumed = false;
    try {
      // The gateway owns both credentials. Initial attach consumes exactly once; resume proves
      // continuity but re-runs live authority and never opens a second PTY.
      const consumed = attach.type === 'attach'
        ? await this.gateway.consumeTicket(attach.session_id, attach.ticket)
        : await this.gateway.resumeSession(attach.session_id, attach.resume_token);
      if (consumed.status !== 'granted') {
        const code = consumed.status === 'ticket_invalid'
          ? CLOSE_CODES.ticket_invalid
          : consumed.status === 'resume_invalid'
            ? CLOSE_CODES.ticket_invalid
          : consumed.status === 'conflict'
            ? CLOSE_CODES.session_conflict
            : consumed.status === 'forbidden' ? CLOSE_CODES.revoked : CLOSE_CODES.internal_error;
        logEvent('terminal_relay_attach_rejected', { session_id: attach.session_id, reason: consumed.status, code });
        if (!gone() && socket.readyState === WS_OPEN) socket.close(code, consumed.status);
        return;
      }
      ticketConsumed = attach.type === 'attach';
      const grant = consumed.grant;
      if (gone() || socket.readyState !== WS_OPEN) {
        if (ticketConsumed) this.sessions.reportConsumedClose(attach.session_id, 'browser_closed');
        return;
      }
      if (attach.type === 'resume') {
        socket.off('message', onMessage);
        const resumed = this.sessions.reattach({
          socket,
          sessionId: attach.session_id,
          grant,
          cols: attach.cols,
          rows: attach.rows,
          afterBytes: attach.after_bytes,
          queued: [...queued]
        });
        if (!resumed && socket.readyState === WS_OPEN) {
          socket.close(CLOSE_CODES.session_conflict, 'resume_conflict');
        }
        return;
      }
      const agent = this.agents.lookup(grant.tenant_id, grant.alias);
      if (!agent) {
        // Never leave the operator on a spinner: an alias with no agent is an explicit close.
        logEvent('terminal_relay_attach_rejected', {
          session_id: attach.session_id, tenant_id: grant.tenant_id, alias: grant.alias, reason: 'agent_offline'
        });
        socket.close(CLOSE_CODES.agent_offline, 'agent_offline');
        this.sessions.reportConsumedClose(attach.session_id, 'agent_offline');
        return;
      }
      if (this.sessions.hasContainerSession(grant.container)) {
        logEvent('terminal_relay_attach_rejected', {
          session_id: attach.session_id, alias: grant.alias, reason: 'session_conflict'
        });
        socket.close(CLOSE_CODES.session_conflict, 'session_conflict');
        this.sessions.reportConsumedClose(attach.session_id, 'session_conflict');
        return;
      }
      socket.off('message', onMessage);
      await this.sessions.open({
        socket,
        sessionId: attach.session_id,
        ticket: attach.ticket,
        grant,
        agent,
        cols: attach.cols,
        rows: attach.rows,
        queued: [...queued]
      });
    } catch (error) {
      logEvent('terminal_relay_attach_failed', { session_id: attach.session_id, error: errorLabel(error) });
      if (socket.readyState === WS_OPEN) socket.close(CLOSE_CODES.internal_error, 'internal_error');
      // `/close` es idempotente en gateway. Si el manager ya alcanzó a reportar, no duplica la
      // auditoría; si lanzó antes de tomar ownership, libera la plaza que `consume` ocupó.
      if (ticketConsumed) this.sessions.reportConsumedClose(attach.session_id, 'attach_failed');
    }
  }
}
