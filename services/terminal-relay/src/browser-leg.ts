import { randomUUID } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { performance } from 'node:perf_hooks';
import { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AgentLookup } from './agent-leg.js';
import { isSessionId } from './framing.js';
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  MAX_CLAIM_LEASE_MS,
  claimEpoch,
  isClaimToken,
  type ConsumeOutcome,
  type ResumeOutcome,
  type TerminalGatewayClient,
  type TerminalSessionGrant,
} from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';
import { isRelayInstanceId } from './relay-identity.js';
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

export const BROWSER_WS_PATH_PREFIX = '/v3/console/terminal/relays';
export function browserWebSocketPath(relayInstanceId: string): string {
  if (!isRelayInstanceId(relayInstanceId)) throw new Error('terminal relay instance id is invalid');
  return `${BROWSER_WS_PATH_PREFIX}/${relayInstanceId}/ws`;
}
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000;
const DEFAULT_CLAIM_RECOVERY_WINDOW_MS = 15_000;
const CLAIM_RETRY_MIN_MS = 25;
const CLAIM_RETRY_MAX_MS = 1_000;
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
  readonly prior_claim_token: string;
  readonly prior_claim_epoch: string;
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
  const priorClaimToken = source.prior_claim_token;
  const priorClaimEpoch = claimEpoch(source.prior_claim_epoch);
  const afterBytes = source.after_bytes;
  if (typeof resumeToken !== 'string' || resumeToken.length < 80 || resumeToken.length > 1_024 ||
      !isClaimToken(priorClaimToken) || priorClaimEpoch === undefined ||
      typeof afterBytes !== 'number' || !Number.isSafeInteger(afterBytes) || afterBytes < 0) return undefined;
  return {
    type: 'resume', session_id: sessionId, resume_token: resumeToken,
    prior_claim_token: priorClaimToken, prior_claim_epoch: priorClaimEpoch,
    after_bytes: afterBytes, ...geometry
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
  readonly relayInstanceId: string;
  readonly consoleCommonNames: readonly string[];
  readonly gateway: TerminalGatewayClient;
  readonly agents: AgentLookup;
  readonly sessions: SessionManager;
  readonly attachTimeoutMs?: number;
  readonly maxConnections?: number;
  readonly maxAttachAttemptsPerSecond?: number;
  /** Test seam and bounded retry budget; uncertain claims remain quarantined after this window. */
  readonly claimRecoveryWindowMs?: number;
}

interface RetainedClaim {
  readonly token: string;
  /** No different claim may be generated before every possibly committed lease has expired. */
  uncertainUntil: number;
}

type ClaimAcquisition =
  | { readonly status: 'granted'; readonly grant: TerminalSessionGrant; readonly requestStartedAt: number }
  | { readonly status: 'ticket_invalid' | 'resume_invalid' | 'forbidden' | 'unavailable' | 'conflict' };

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
  private readonly websocketPath: string;
  private readonly consoleCommonNames: ReadonlySet<string>;
  private readonly gateway: TerminalGatewayClient;
  private readonly agents: AgentLookup;
  private readonly sessions: SessionManager;
  private readonly attachTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly maxAttachAttemptsPerSecond: number;
  private readonly claimRecoveryWindowMs: number;
  private readonly wss: WebSocketServer;
  /** Initial OPEN redemptions in flight. Resume has its own single-socket gate in SessionManager. */
  private readonly pendingClaimAttaches = new Set<string>();
  /** Capability material lives only in process memory and is never included in logs. */
  private readonly retainedClaims = new Map<string, RetainedClaim>();
  private attachWindowStartedAt = 0;
  private attachAttempts = 0;

  constructor(options: BrowserLegOptions) {
    this.server = options.server;
    this.websocketPath = browserWebSocketPath(options.relayInstanceId);
    this.consoleCommonNames = new Set(options.consoleCommonNames);
    this.gateway = options.gateway;
    this.agents = options.agents;
    this.sessions = options.sessions;
    this.attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
    this.maxConnections = options.maxConnections ?? 64;
    this.maxAttachAttemptsPerSecond = options.maxAttachAttemptsPerSecond ?? 32;
    this.claimRecoveryWindowMs = options.claimRecoveryWindowMs ?? DEFAULT_CLAIM_RECOVERY_WINDOW_MS;
    if (!Number.isSafeInteger(this.claimRecoveryWindowMs) || this.claimRecoveryWindowMs < 1
        || this.claimRecoveryWindowMs > MAX_CLAIM_LEASE_MS) {
      throw new Error('claimRecoveryWindowMs must be between 1 and the maximum claim lease');
    }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.server.on('upgrade', (request, socket, head) => {
      const path = (request.url ?? '/').split('?', 1)[0];
      if (path !== this.websocketPath) {
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
    await new Promise<void>((resolve) => { this.wss.close(() => { resolve(); }); });
    await new Promise<void>((resolve) => this.server.close(() => { resolve(); }));
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
    attachTimer.unref();
    socket.once('close', () => {
      gone = true;
      clearTimeout(attachTimer);
    });
    socket.on('error', () => { socket.terminate(); });
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
    const localFence = attach.type === 'resume'
      ? this.sessions.claimForSession(attach.session_id)
      : undefined;
    if (attach.type === 'resume' && localFence !== undefined
        && (attach.prior_claim_token !== localFence.token
          || attach.prior_claim_epoch !== localFence.epoch)) {
      logEvent('terminal_relay_attach_rejected', {
        session_id: attach.session_id,
        reason: 'resume_fence_mismatch',
        code: CLOSE_CODES.session_conflict,
      });
      if (!gone() && socket.readyState === WS_OPEN) {
        socket.close(CLOSE_CODES.session_conflict, 'resume_conflict');
      }
      return;
    }

    // Initial redemption and post-crash resume both acquire a new DB claim. A resume for a PTY
    // still owned by this SessionManager renews its local fence and therefore uses the manager's
    // copy, never the capability echoed by the browser as authority.
    const needsReservation = attach.type === 'attach' || localFence === undefined;
    if (needsReservation) {
      if (this.pendingClaimAttaches.has(attach.session_id)
          || (attach.type === 'attach' && this.sessions.hasSession(attach.session_id))) {
        logEvent('terminal_relay_attach_rejected', {
          session_id: attach.session_id,
          reason: attach.type === 'attach' && this.sessions.hasSession(attach.session_id)
            ? 'session_already_active'
            : 'claim_in_progress',
          code: CLOSE_CODES.session_conflict,
        });
        if (!gone() && socket.readyState === WS_OPEN) {
          socket.close(CLOSE_CODES.session_conflict, 'session_conflict');
        }
        return;
      }
      this.pendingClaimAttaches.add(attach.session_id);
    }
    let acquiredGrant: TerminalSessionGrant | undefined;
    const reportAbandonedClaim = (reason: string): void => {
      // The reservation makes this the one local attempt allowed to consume. Never let a loser
      // close an already active winner merely because both presented the same durable receipt.
      if (needsReservation && acquiredGrant !== undefined
          && !this.sessions.hasSession(attach.session_id)) {
        this.sessions.reportConsumedClose(attach.session_id, reason, acquiredGrant);
      }
    };
    try {
      const claimToken = localFence?.token ?? this.retainedClaim(attach.session_id);
      const consumed = await this.acquireClaim(attach, claimToken, localFence?.epoch);
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
      const grant = consumed.grant;
      acquiredGrant = needsReservation ? grant : undefined;
      if (gone() || socket.readyState !== WS_OPEN) {
        reportAbandonedClaim('browser_closed');
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
          claimRequestStartedAt: consumed.requestStartedAt,
          afterBytes: attach.after_bytes,
          queued: [...queued]
        });
        if (!resumed) {
          socket.close(CLOSE_CODES.session_conflict, 'resume_conflict');
          reportAbandonedClaim('relay_state_lost');
          return;
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
        reportAbandonedClaim('agent_offline');
        return;
      }
      if (this.sessions.hasSession(attach.session_id)) {
        logEvent('terminal_relay_attach_rejected', {
          session_id: attach.session_id,
          alias: grant.alias,
          reason: 'session_already_active',
        });
        socket.close(CLOSE_CODES.session_conflict, 'session_conflict');
        return;
      }
      if (this.sessions.hasContainerSession(grant.container)) {
        logEvent('terminal_relay_attach_rejected', {
          session_id: attach.session_id, alias: grant.alias, reason: 'session_conflict'
        });
        socket.close(CLOSE_CODES.session_conflict, 'session_conflict');
        reportAbandonedClaim('session_conflict');
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
        claimRequestStartedAt: consumed.requestStartedAt,
        queued: [...queued]
      });
    } catch (error) {
      logEvent('terminal_relay_attach_failed', { session_id: attach.session_id, error: errorLabel(error) });
      if (socket.readyState === WS_OPEN) socket.close(CLOSE_CODES.internal_error, 'internal_error');
      // `/close` es idempotente en gateway. Si el manager ya alcanzó a reportar, no duplica la
      // auditoría; si lanzó antes de tomar ownership, libera la plaza que `consume` ocupó.
      reportAbandonedClaim('attach_failed');
    } finally {
      if (needsReservation) this.pendingClaimAttaches.delete(attach.session_id);
    }
  }

  /** Reuses a possibly committed capability until its maximum DB lease is certainly gone. */
  private retainedClaim(sessionId: string): string {
    const now = performance.now();
    for (const [sid, claim] of this.retainedClaims) {
      if (claim.uncertainUntil > 0 && claim.uncertainUntil <= now) this.retainedClaims.delete(sid);
    }
    const retained = this.retainedClaims.get(sessionId);
    if (retained !== undefined) return retained.token;
    const token = randomUUID();
    this.retainedClaims.set(sessionId, { token, uncertainUntil: 0 });
    return token;
  }

  /**
   * Every ambiguous retry uses the identical claim. When the short online retry budget expires,
   * the raw claim remains quarantined in memory until the longest possible lease plus request
   * timeout has elapsed, so a later browser retry cannot accidentally mint a competing fence.
   */
  private async acquireClaim(
    attach: AttachRequest,
    claimToken: string,
    exactEpoch?: string,
  ): Promise<ClaimAcquisition> {
    const retryDeadline = performance.now() + this.claimRecoveryWindowMs;
    let delayMs = CLAIM_RETRY_MIN_MS;
    for (;;) {
      const requestStartedAt = performance.now();
      let outcome: ConsumeOutcome | ResumeOutcome;
      try {
        outcome = attach.type === 'attach'
          ? await this.gateway.consumeTicket(attach.session_id, attach.ticket, claimToken)
          : await this.gateway.resumeSession(
            attach.session_id,
            attach.resume_token,
            claimToken,
            exactEpoch,
          );
      } catch {
        outcome = { status: 'unavailable' };
      }
      if (outcome.status === 'granted') {
        if (outcome.grant.claim_token === claimToken
            && (exactEpoch === undefined || outcome.grant.claim_epoch === exactEpoch)) {
          this.retainedClaims.delete(attach.session_id);
          return { status: 'granted', grant: outcome.grant, requestStartedAt };
        }
        // A malformed/misdirected 200 may still hide a committed exact claim. Treat it as an
        // ambiguous response and keep the requested capability quarantined.
        outcome = { status: 'unavailable' };
      }
      if (outcome.status !== 'unavailable') {
        this.retainedClaims.delete(attach.session_id);
        return { status: outcome.status };
      }
      const retained = this.retainedClaims.get(attach.session_id);
      if (retained?.token === claimToken) {
        retained.uncertainUntil = Math.max(
          retained.uncertainUntil,
          requestStartedAt + MAX_CLAIM_LEASE_MS + DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
        );
      }
      const now = performance.now();
      if (now >= retryDeadline) return { status: 'unavailable' };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(delayMs, retryDeadline - now));
        timer.unref();
      });
      delayMs = Math.min(CLAIM_RETRY_MAX_MS, delayMs * 2);
    }
  }
}
