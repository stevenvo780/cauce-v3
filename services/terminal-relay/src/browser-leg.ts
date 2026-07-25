import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AgentLookup } from './agent-leg.js';
import { isSessionId } from './framing.js';
import type { TerminalGatewayClient } from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';
import {
  CLOSE_CODES, isValidCols, isValidRows, rawText, SessionManager, type QueuedClientMessage
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

export interface AttachRequest {
  readonly session_id: string;
  readonly ticket: string;
  readonly cols: number;
  readonly rows: number;
}

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
  if (source.type !== 'attach') return undefined;
  const sessionId = source.session_id;
  const ticket = source.ticket;
  if (typeof sessionId !== 'string' || !isSessionId(sessionId)) return undefined;
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 4096) return undefined;
  if (!isValidCols(source.cols) || !isValidRows(source.rows)) return undefined;
  return { session_id: sessionId, ticket, cols: source.cols, rows: source.rows };
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
}

export class BrowserLeg {
  private readonly server: HttpsServer;
  private readonly consoleCommonNames: ReadonlySet<string>;
  private readonly gateway: TerminalGatewayClient;
  private readonly agents: AgentLookup;
  private readonly sessions: SessionManager;
  private readonly attachTimeoutMs: number;
  private readonly wss: WebSocketServer;

  constructor(options: BrowserLegOptions) {
    this.server = options.server;
    this.consoleCommonNames = new Set(options.consoleCommonNames);
    this.gateway = options.gateway;
    this.agents = options.agents;
    this.sessions = options.sessions;
    this.attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.server.on('upgrade', (request, socket, head) => {
      const path = (request.url ?? '/').split('?', 1)[0];
      if (path !== BROWSER_WS_PATH) {
        socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      const commonName = consoleCommonName(socket);
      if (commonName === undefined || !this.consoleCommonNames.has(commonName)) {
        logEvent('terminal_relay_console_rejected', { reason: 'untrusted_client_certificate' });
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
        if (queued.length < MAX_QUEUED_MESSAGES) queued.push({ data, isBinary });
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

  private async attach(
    socket: WebSocket,
    attach: AttachRequest,
    queued: QueuedClientMessage[],
    gone: () => boolean,
    onMessage: (data: RawData, isBinary: boolean) => void
  ): Promise<void> {
    try {
      // The gateway owns the ticket: it verifies, marks it consumed and answers with the grant.
      const consumed = await this.gateway.consumeTicket(attach.session_id, attach.ticket);
      if (gone() || socket.readyState !== WS_OPEN) return;
      if (consumed.status !== 'granted') {
        const code = consumed.status === 'ticket_invalid'
          ? CLOSE_CODES.ticket_invalid
          : consumed.status === 'conflict'
            ? CLOSE_CODES.session_conflict
            : consumed.status === 'forbidden' ? CLOSE_CODES.revoked : CLOSE_CODES.internal_error;
        logEvent('terminal_relay_attach_rejected', { session_id: attach.session_id, reason: consumed.status, code });
        socket.close(code, consumed.status);
        return;
      }
      const grant = consumed.grant;
      const agent = this.agents.lookup(grant.tenant_id, grant.alias);
      if (!agent) {
        // Never leave the operator on a spinner: an alias with no agent is an explicit close.
        logEvent('terminal_relay_attach_rejected', {
          session_id: attach.session_id, tenant_id: grant.tenant_id, alias: grant.alias, reason: 'agent_offline'
        });
        socket.close(CLOSE_CODES.agent_offline, 'agent_offline');
        return;
      }
      if (this.sessions.hasContainerSession(grant.tenant_id, grant.alias, grant.container)) {
        logEvent('terminal_relay_attach_rejected', {
          session_id: attach.session_id, alias: grant.alias, reason: 'session_conflict'
        });
        socket.close(CLOSE_CODES.session_conflict, 'session_conflict');
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
    }
  }
}
