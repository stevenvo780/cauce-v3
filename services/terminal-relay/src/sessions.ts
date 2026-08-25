import type { RawData, WebSocket } from 'ws';
import type { AgentConnection } from './agent-leg.js';
import type { SessionCloseReport, TerminalGatewayClient, TerminalSessionGrant } from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';

/**
 * Session lifecycle and limits. Everything that can end a terminal lives here: revocation,
 * idle, TTL, output flood and backpressure. The rule that shapes the file is fail closed —
 * a session whose authorization cannot be re-confirmed is torn down, never grandfathered.
 */

export const CLOSE_CODES = {
  normal: 1000,
  going_away: 1001,
  internal_error: 1011,
  protocol_error: 4400,
  ticket_invalid: 4401,
  revoked: 4403,
  agent_offline: 4404,
  idle_timeout: 4408,
  session_conflict: 4409,
  output_flood: 4413,
  ttl_expired: 4423
} as const;

export const MIN_COLS = 20;
export const MAX_COLS = 500;
export const MIN_ROWS = 5;
export const MAX_ROWS = 200;

/** Keystrokes are coalesced so a burst of typing costs one frame, not one frame per key. */
const STDIN_COALESCE_MS = 8;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_WINDOW_MS = 1_000;
/** Sustained flood: warn after three windows over the limit, close two windows later. */
const FLOOD_WARN_WINDOWS = 3;
const FLOOD_CLOSE_WINDOWS = 5;
const BACKPRESSURE_HIGH_BYTES = 4 * 1024 * 1024;
const BACKPRESSURE_LOW_BYTES = 1024 * 1024;
const BACKPRESSURE_POLL_MS = 25;
/** Frames held while the agent opens the PTY; a client flooding that window is not typing. */
const MAX_EARLY_MESSAGES = 64;
const WS_OPEN = 1;

export interface SessionLimits {
  readonly idleTimeoutMs: number;
  readonly outputRateBytesPerSec: number;
  readonly scrollbackBytes: number;
  readonly maxSessions: number;
  readonly authzIntervalMs: number;
  readonly authzGraceMs: number;
  readonly openTimeoutMs?: number;
  /** Test seam only; production accounts output in the one-second windows of the contract. */
  readonly outputWindowMs?: number;
}

export interface QueuedClientMessage {
  readonly data: RawData;
  readonly isBinary: boolean;
}

export interface OpenSessionInput {
  readonly socket: WebSocket;
  readonly sessionId: string;
  readonly ticket: string;
  readonly grant: TerminalSessionGrant;
  readonly agent: AgentConnection;
  readonly cols: number;
  readonly rows: number;
  /** Client frames that arrived while the gateway was being consulted. */
  readonly queued?: readonly QueuedClientMessage[];
}

export type ClientMessage =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'ping' };

/** Un entero finito de verdad: descarta NaN, Infinity, decimales y cualquier cosa que no sea número. */
function isEnteroFinito(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Lleva `valor` al rango [minimo, maximo] en vez de rechazarlo. */
function acotar(valor: number, minimo: number, maximo: number): number {
  return Math.min(maximo, Math.max(minimo, valor));
}

export function isValidCols(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_COLS && value <= MAX_COLS;
}

export function isValidRows(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_ROWS && value <= MAX_ROWS;
}

/** `ws` hands us a Buffer, a fragment list or an ArrayBuffer depending on how the frame arrived. */
export function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Anything the browser sends that is not one of the three control frames is a protocol error. */
export function parseClientMessage(data: RawData, isBinary: boolean): ClientMessage | undefined {
  // Binary from the browser is never valid: input travels as JSON, output as binary.
  if (isBinary) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText(data));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const source = parsed as Record<string, unknown>;
  if (source.type === 'input') {
    return typeof source.data === 'string' ? { type: 'input', data: source.data } : undefined;
  }
  if (source.type === 'resize') {
    // Un resize fuera de rango se ACOTA, nunca se rechaza. Devolver `undefined` aquí hacía que el
    // llamador cerrase la sesión con protocol_error 4400: una tercera terminal que mandaba rows:1
    // se llevaba puestas las dos que ya estaban vivas (arreglado en prod el 2026-08-24, portado
    // aquí para no revertirlo). Lo que no es un número entero sí sigue siendo un mensaje inválido.
    if (!isEnteroFinito(source.cols) || !isEnteroFinito(source.rows)) return undefined;
    return {
      type: 'resize',
      cols: acotar(source.cols, MIN_COLS, MAX_COLS),
      rows: acotar(source.rows, MIN_ROWS, MAX_ROWS),
    };
  }
  if (source.type === 'ping') return { type: 'ping' };
  return undefined;
}

interface ScrollbackEntry {
  chunks: Buffer[];
  bytes: number;
  expiresAt: number;
}

export interface SessionManagerOptions {
  readonly gateway: TerminalGatewayClient;
  readonly limits: SessionLimits;
  readonly now?: () => number;
}

export class SessionManager {
  private readonly gateway: TerminalGatewayClient;
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly containers = new Map<string, string>();
  private readonly scrollback = new Map<string, ScrollbackEntry>();
  private readonly pendingReports = new Set<Promise<void>>();

  constructor(options: SessionManagerOptions) {
    this.gateway = options.gateway;
    this.limits = options.limits;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** One terminal per destination container: two shells in the same box is a conflict. */
  hasContainerSession(tenantId: string, alias: string, container: string): boolean {
    return this.containers.has(containerKey(tenantId, alias, container));
  }

  async open(input: OpenSessionInput): Promise<void> {
    this.pruneScrollback();
    if (this.sessions.size >= this.limits.maxSessions) {
      closeSocket(input.socket, CLOSE_CODES.session_conflict, 'session_limit');
      logEvent('terminal_relay_session_rejected', { session_id: input.sessionId, reason: 'session_limit' });
      return;
    }
    const container = containerKey(input.grant.tenant_id, input.grant.alias, input.grant.container);
    if (this.sessions.has(input.sessionId) || this.containers.has(container)) {
      closeSocket(input.socket, CLOSE_CODES.session_conflict, 'session_conflict');
      logEvent('terminal_relay_session_rejected', { session_id: input.sessionId, reason: 'session_conflict' });
      return;
    }
    const session = new TerminalSession(this, this.gateway, this.limits, this.now, input);
    this.sessions.set(input.sessionId, session);
    this.containers.set(container, input.sessionId);
    await session.start(input.queued ?? []);
  }

  closeAll(code: number, reason: string): void {
    for (const session of [...this.sessions.values()]) session.terminate(code, reason);
  }

  /**
   * Lets a shutdown wait for the close reports to land. The audit trail of a terminal ends with
   * that POST, so dropping it on SIGTERM would leave sessions that look like they never closed.
   */
  async flush(timeoutMs = 2_000): Promise<void> {
    if (this.pendingReports.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.pendingReports]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
  }

  /** @internal */
  trackReport(report: Promise<void>): void {
    this.pendingReports.add(report);
    void report.finally(() => this.pendingReports.delete(report));
  }

  /** @internal */
  release(sessionId: string, container: string): void {
    this.sessions.delete(sessionId);
    if (this.containers.get(container) === sessionId) this.containers.delete(container);
  }

  /** @internal */
  scrollbackFor(sessionId: string, expiresAt: number): ScrollbackEntry {
    const existing = this.scrollback.get(sessionId);
    if (existing) {
      existing.expiresAt = expiresAt;
      return existing;
    }
    const entry: ScrollbackEntry = { chunks: [], bytes: 0, expiresAt };
    this.scrollback.set(sessionId, entry);
    return entry;
  }

  private pruneScrollback(): void {
    const now = this.now();
    for (const [sessionId, entry] of this.scrollback) {
      if (entry.expiresAt <= now) this.scrollback.delete(sessionId);
    }
    // Hard cap so a relay that never restarts cannot accumulate replay buffers forever.
    const cap = Math.max(this.limits.maxSessions * 4, 8);
    while (this.scrollback.size > cap) {
      const oldest = this.scrollback.keys().next();
      if (oldest.done === true) break;
      this.scrollback.delete(oldest.value);
    }
  }
}

function containerKey(tenantId: string, alias: string, container: string): string {
  return `${tenantId} ${alias} ${container}`;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    // A socket that is already gone needs no closing.
  }
}

export class TerminalSession {
  private readonly manager: SessionManager;
  private readonly gateway: TerminalGatewayClient;
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  private readonly socket: WebSocket;
  private readonly agent: AgentConnection;
  private readonly grant: TerminalSessionGrant;
  private readonly sessionId: string;
  private readonly ticket: string;
  private readonly container: string;
  private readonly expiresAtMs: number;
  private readonly scrollback: ScrollbackEntry;
  private cols: number;
  private rows: number;
  private bytesIn = 0;
  private bytesOut = 0;
  private windowBytes = 0;
  private floodWindows = 0;
  private lastAuthzOkAt: number;
  private authzInFlight = false;
  private exitCode: number | null = null;
  private agentClosed = false;
  private closed = false;
  private stdin: Buffer[] = [];
  private stdinTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private ttlTimer: NodeJS.Timeout | undefined;
  private authzTimer: NodeJS.Timeout | undefined;
  private windowTimer: NodeJS.Timeout | undefined;
  private drainTimer: NodeJS.Timeout | undefined;
  private openTimer: NodeJS.Timeout | undefined;
  private settleOpen: ((opened: boolean) => void) | undefined;

  constructor(
    manager: SessionManager,
    gateway: TerminalGatewayClient,
    limits: SessionLimits,
    now: () => number,
    input: OpenSessionInput
  ) {
    this.manager = manager;
    this.gateway = gateway;
    this.limits = limits;
    this.now = now;
    this.socket = input.socket;
    this.agent = input.agent;
    this.grant = input.grant;
    this.sessionId = input.sessionId;
    this.ticket = input.ticket;
    this.container = containerKey(input.grant.tenant_id, input.grant.alias, input.grant.container);
    this.cols = input.cols;
    this.rows = input.rows;
    this.expiresAtMs = Date.parse(input.grant.session_expires_at);
    this.lastAuthzOkAt = now();
    this.scrollback = manager.scrollbackFor(input.sessionId, this.expiresAtMs);
  }

  async start(queued: readonly QueuedClientMessage[]): Promise<void> {
    this.socket.on('close', () => this.terminate(CLOSE_CODES.normal, 'browser_closed'));
    this.socket.on('error', () => this.terminate(CLOSE_CODES.internal_error, 'browser_socket_error'));
    // Listening from the first synchronous moment: whatever is typed while the agent is opening
    // the PTY is held, not lost, and is replayed in order once the session is ready.
    let ready = false;
    const early: QueuedClientMessage[] = [...queued];
    this.socket.on('message', (data: RawData, isBinary: boolean) => {
      if (ready) {
        this.onClientMessage(data, isBinary);
        return;
      }
      if (early.length < MAX_EARLY_MESSAGES) early.push({ data, isBinary });
    });
    const opened = await this.openOnAgent();
    if (!opened || this.closed) return;
    this.sendControl({
      type: 'ready',
      session_id: this.sessionId,
      alias: this.grant.alias,
      tenant_id: this.grant.tenant_id,
      container: this.grant.container,
      runtime_user: this.grant.runtime_user,
      mode: this.grant.mode,
      expires_at: this.grant.session_expires_at
    });
    this.replayScrollback();
    this.startTimers();
    ready = true;
    for (const message of early) {
      if (this.closed) break;
      this.onClientMessage(message.data, message.isBinary);
    }
    logEvent('terminal_relay_session_started', {
      session_id: this.sessionId,
      tenant_id: this.grant.tenant_id,
      alias: this.grant.alias,
      container: this.grant.container,
      runtime_user: this.grant.runtime_user,
      mode: this.grant.mode
    });
  }

  terminate(code: number, reason: string, exitCode: number | null = null): void {
    if (this.closed) return;
    this.closed = true;
    if (exitCode !== null) this.exitCode = exitCode;
    this.clearTimers();
    // A teardown mid-handshake must release `start()`, or the attach would hang forever.
    this.settleOpen?.(false);
    this.settleOpen = undefined;
    if (!this.agentClosed && this.agent.alive) this.agent.sendClose(this.sessionId, reason);
    this.agent.detachSession(this.sessionId);
    this.manager.release(this.sessionId, this.container);
    if (this.socket.readyState === WS_OPEN) {
      this.sendControl({ type: 'closed', reason, exit_code: this.exitCode });
      closeSocket(this.socket, code, reason);
    }
    const report: SessionCloseReport = {
      reason,
      exit_code: this.exitCode,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut
    };
    this.manager.trackReport(Promise.resolve(this.gateway.reportClose(this.sessionId, report)).catch((error: unknown) => {
      logEvent('terminal_relay_close_report_failed', { session_id: this.sessionId, error: errorLabel(error) });
    }));
    logEvent('terminal_relay_session_closed', {
      session_id: this.sessionId,
      alias: this.grant.alias,
      code,
      reason,
      exit_code: this.exitCode,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut
    });
  }

  /** Sends OPEN and resolves once the agent answers, or tears the session down trying. */
  private openOnAgent(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.openTimer) clearTimeout(this.openTimer);
        this.openTimer = undefined;
        this.settleOpen = undefined;
        resolve(value);
      };
      this.settleOpen = settle;
      this.agent.attachSession(this.sessionId, {
        onOpenOk: () => settle(true),
        onOpenErr: (reason) => {
          // The agent is the second gate on the ticket: it may refuse what the relay accepted.
          const code = reason === 'ticket_invalid'
            ? CLOSE_CODES.ticket_invalid
            : reason === 'revoked' ? CLOSE_CODES.revoked : CLOSE_CODES.internal_error;
          this.terminate(code, reason);
          settle(false);
        },
        onStdout: (data) => this.onStdout(data),
        onClosed: (exit) => {
          this.agentClosed = true;
          this.terminate(CLOSE_CODES.normal, exit.reason, exit.exit_code);
          settle(false);
        },
        onAgentGone: (reason) => {
          this.agentClosed = true;
          this.terminate(CLOSE_CODES.agent_offline, reason);
          settle(false);
        }
      });
      this.openTimer = setTimeout(() => {
        this.terminate(CLOSE_CODES.internal_error, 'open_timeout');
        settle(false);
      }, this.limits.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
      this.openTimer.unref?.();
      try {
        this.agent.sendOpen(this.sessionId, this.ticket, this.grant.mode, this.cols, this.rows);
      } catch (error) {
        logEvent('terminal_relay_open_failed', { session_id: this.sessionId, error: errorLabel(error) });
        this.terminate(CLOSE_CODES.internal_error, 'open_failed');
        settle(false);
      }
    });
  }

  private onClientMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    try {
      const message = parseClientMessage(data, isBinary);
      if (!message) {
        this.terminate(CLOSE_CODES.protocol_error, 'protocol_error');
        return;
      }
      if (message.type === 'ping') return;
      if (message.type === 'resize') {
        this.cols = message.cols;
        this.rows = message.rows;
        this.agent.sendResize(this.sessionId, message.cols, message.rows);
        return;
      }
      const bytes = Buffer.from(message.data, 'utf8');
      this.bytesIn += bytes.byteLength;
      this.stdin.push(bytes);
      this.resetIdle();
      if (this.stdinTimer === undefined) {
        this.stdinTimer = setTimeout(() => this.flushStdin(), STDIN_COALESCE_MS);
        this.stdinTimer.unref?.();
      }
    } catch (error) {
      logEvent('terminal_relay_client_message_failed', { session_id: this.sessionId, error: errorLabel(error) });
      this.terminate(CLOSE_CODES.internal_error, 'client_message_failed');
    }
  }

  private flushStdin(): void {
    this.stdinTimer = undefined;
    if (this.closed || this.stdin.length === 0) return;
    const pending = Buffer.concat(this.stdin);
    this.stdin = [];
    try {
      this.agent.sendStdin(this.sessionId, pending);
    } catch (error) {
      logEvent('terminal_relay_stdin_failed', { session_id: this.sessionId, error: errorLabel(error) });
      this.terminate(CLOSE_CODES.internal_error, 'stdin_failed');
    }
  }

  private onStdout(data: Buffer): void {
    if (this.closed || data.byteLength === 0) return;
    this.bytesOut += data.byteLength;
    this.windowBytes += data.byteLength;
    this.rememberScrollback(data);
    if (this.socket.readyState !== WS_OPEN) return;
    // PTY output is always binary; control frames are always text. The client splits on that.
    this.socket.send(data, { binary: true });
    this.applyBackpressure();
  }

  /** Keeps the tail of the output so a reattach can repaint the screen the operator lost. */
  private rememberScrollback(data: Buffer): void {
    this.scrollback.chunks.push(data);
    this.scrollback.bytes += data.byteLength;
    const limit = this.limits.scrollbackBytes;
    while (this.scrollback.bytes > limit) {
      const oldest = this.scrollback.chunks[0];
      if (oldest === undefined) break;
      const excess = this.scrollback.bytes - limit;
      if (oldest.byteLength <= excess) {
        this.scrollback.chunks.shift();
        this.scrollback.bytes -= oldest.byteLength;
        continue;
      }
      this.scrollback.chunks[0] = oldest.subarray(excess);
      this.scrollback.bytes -= excess;
    }
  }

  private replayScrollback(): void {
    if (this.scrollback.bytes === 0 || this.socket.readyState !== WS_OPEN) return;
    this.sendControl({ type: 'notice', level: 'info', message: 'replaying buffered output of the reattached session' });
    this.socket.send(Buffer.concat(this.scrollback.chunks), { binary: true });
  }

  private applyBackpressure(): void {
    if (this.socket.bufferedAmount <= BACKPRESSURE_HIGH_BYTES || this.drainTimer !== undefined) return;
    this.agent.pauseOutput();
    this.drainTimer = setInterval(() => {
      if (this.closed || this.socket.bufferedAmount < BACKPRESSURE_LOW_BYTES) {
        if (this.drainTimer) clearInterval(this.drainTimer);
        this.drainTimer = undefined;
        this.agent.resumeOutput();
      }
    }, BACKPRESSURE_POLL_MS);
    this.drainTimer.unref?.();
  }

  private startTimers(): void {
    this.resetIdle();
    const remaining = this.expiresAtMs - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.terminate(CLOSE_CODES.ttl_expired, 'ttl_expired');
      return;
    }
    this.ttlTimer = setTimeout(() => this.terminate(CLOSE_CODES.ttl_expired, 'ttl_expired'), remaining);
    this.ttlTimer.unref?.();
    this.authzTimer = setInterval(() => void this.revalidate(), this.limits.authzIntervalMs);
    this.authzTimer.unref?.();
    this.windowTimer = setInterval(() => this.closeWindow(), this.limits.outputWindowMs ?? DEFAULT_OUTPUT_WINDOW_MS);
    this.windowTimer.unref?.();
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.terminate(CLOSE_CODES.idle_timeout, 'idle_timeout'), this.limits.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /**
   * Re-asks the gateway whether this session may continue. An unreachable gateway is not an
   * allow: once the grace window is spent the terminal dies, because the alternative is a
   * shell that outlives the revocation of its own permission.
   */
  private async revalidate(): Promise<void> {
    if (this.closed || this.authzInFlight) return;
    this.authzInFlight = true;
    try {
      const outcome = await this.gateway.authorizeSession(this.sessionId);
      if (this.closed) return;
      if (outcome === 'allow') {
        this.lastAuthzOkAt = this.now();
        return;
      }
      if (outcome === 'revoked') {
        this.terminate(CLOSE_CODES.revoked, 'revoked');
        return;
      }
      if (this.now() - this.lastAuthzOkAt > this.limits.authzGraceMs) {
        this.terminate(CLOSE_CODES.revoked, 'authz_unreachable');
      }
    } catch (error) {
      logEvent('terminal_relay_authz_failed', { session_id: this.sessionId, error: errorLabel(error) });
      if (!this.closed && this.now() - this.lastAuthzOkAt > this.limits.authzGraceMs) {
        this.terminate(CLOSE_CODES.revoked, 'authz_unreachable');
      }
    } finally {
      this.authzInFlight = false;
    }
  }

  private closeWindow(): void {
    if (this.closed) return;
    const windowMs = this.limits.outputWindowMs ?? DEFAULT_OUTPUT_WINDOW_MS;
    const allowance = (this.limits.outputRateBytesPerSec * windowMs) / 1_000;
    const flooded = this.windowBytes > allowance;
    this.windowBytes = 0;
    this.floodWindows = flooded ? this.floodWindows + 1 : 0;
    if (this.floodWindows === FLOOD_WARN_WINDOWS) {
      this.sendControl({
        type: 'notice',
        level: 'warn',
        message: 'output rate is above the terminal limit; the session will close if it continues'
      });
      logEvent('terminal_relay_output_flood_warned', { session_id: this.sessionId, alias: this.grant.alias });
      return;
    }
    if (this.floodWindows >= FLOOD_CLOSE_WINDOWS) this.terminate(CLOSE_CODES.output_flood, 'output_flood');
  }

  private sendControl(message: Record<string, unknown>): void {
    if (this.socket.readyState !== WS_OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      logEvent('terminal_relay_control_send_failed', { session_id: this.sessionId, error: errorLabel(error) });
    }
  }

  private clearTimers(): void {
    if (this.stdinTimer) clearTimeout(this.stdinTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    if (this.authzTimer) clearInterval(this.authzTimer);
    if (this.windowTimer) clearInterval(this.windowTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.openTimer) clearTimeout(this.openTimer);
    this.stdinTimer = undefined;
    this.idleTimer = undefined;
    this.ttlTimer = undefined;
    this.authzTimer = undefined;
    this.windowTimer = undefined;
    this.drainTimer = undefined;
    this.openTimer = undefined;
  }
}
