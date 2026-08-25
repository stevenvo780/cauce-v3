import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync
} from 'node:fs';
import { dirname } from 'node:path';
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
  input_flood: 4414,
  slow_consumer: 4415,
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
const DEFAULT_RECONNECT_GRACE_MS = 30_000;
const CLOSE_RETRY_MIN_MS = 250;
const CLOSE_RETRY_MAX_MS = 30_000;
/** Frames held while the agent opens the PTY; a client flooding that window is not typing. */
const MAX_EARLY_MESSAGES = 64;
export const MAX_INPUT_MESSAGE_BYTES = 16 * 1024;
export const MAX_PENDING_STDIN_BYTES = 64 * 1024;
/** Includes JSON overhead and control frames while OPEN is in flight. */
export const MAX_EARLY_CLIENT_BYTES = 128 * 1024;
const WS_OPEN = 1;

export interface SessionLimits {
  readonly idleTimeoutMs: number;
  readonly outputRateBytesPerSec: number;
  readonly scrollbackBytes: number;
  readonly maxSessions: number;
  readonly authzIntervalMs: number;
  readonly authzGraceMs: number;
  readonly reconnectGraceMs?: number;
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

export interface ReattachSessionInput {
  readonly socket: WebSocket;
  readonly sessionId: string;
  readonly grant: TerminalSessionGrant;
  readonly cols: number;
  readonly rows: number;
  /** Number of PTY output bytes the browser already received before the transport broke. */
  readonly afterBytes: number;
  readonly queued?: readonly QueuedClientMessage[];
}

export type ClientMessage =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'terminal_response'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'ping' };

/** Juego cerrado que xterm 5.5 emite para DA/DSR; cualquier otra secuencia falla cerrada. */
export const MAX_TERMINAL_RESPONSE_BYTES = 256;
const PRIMARY_DA = '\x1b[?1;2c';
const SECONDARY_DA = '\x1b[>0;276;0c';
const STATUS_DSR = '\x1b[0n';

/** Un entero finito de verdad: descarta NaN, Infinity, decimales y cualquier cosa que no sea número. */
function isEnteroFinito(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Lleva `valor` al rango [minimo, maximo] en vez de rechazarlo. */
function acotar(valor: number, minimo: number, maximo: number): number {
  return Math.min(maximo, Math.max(minimo, valor));
}

function positiveDecimal(value: string): boolean {
  if (value.length === 0 || value.length > 3 || value[0] === '0') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

function cursorResponseLength(data: string): number {
  if (!data.startsWith('\x1b[')) return 0;
  let start = 2;
  if (data[start] === '?') start += 1;
  const separator = data.indexOf(';', start);
  if (separator < 0) return 0;
  const end = data.indexOf('R', separator + 1);
  if (end < 0) return 0;
  const row = data.slice(start, separator);
  const col = data.slice(separator + 1, end);
  if (!positiveDecimal(row) || !positiveDecimal(col)) return 0;
  if (Number(row) > MAX_ROWS || Number(col) > MAX_COLS) return 0;
  return end + 1;
}

/** Enteros fuera de rango se acotan igual en attach y resize; otros tipos son protocolo inválido. */
export function clampTerminalGeometry(
  cols: unknown,
  rows: unknown
): { readonly cols: number; readonly rows: number } | undefined {
  if (!isEnteroFinito(cols) || !isEnteroFinito(rows)) return undefined;
  return { cols: acotar(cols, MIN_COLS, MAX_COLS), rows: acotar(rows, MIN_ROWS, MAX_ROWS) };
}

export function isTerminalEmulatorResponse(data: string): boolean {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes === 0 || bytes > MAX_TERMINAL_RESPONSE_BYTES || bytes !== data.length) return false;
  let pending = data;
  while (pending.length > 0) {
    if (pending.startsWith(PRIMARY_DA)) {
      pending = pending.slice(PRIMARY_DA.length);
      continue;
    }
    if (pending.startsWith(SECONDARY_DA)) {
      pending = pending.slice(SECONDARY_DA.length);
      continue;
    }
    if (pending.startsWith(STATUS_DSR)) {
      pending = pending.slice(STATUS_DSR.length);
      continue;
    }
    const length = cursorResponseLength(pending);
    if (length === 0) return false;
    pending = pending.slice(length);
  }
  return true;
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

export function rawDataByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  return data.byteLength;
}

/** Anything the browser sends that is not one of these typed control frames is a protocol error. */
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
  if (source.type === 'terminal_response') {
    return typeof source.data === 'string' && isTerminalEmulatorResponse(source.data)
      ? { type: 'terminal_response', data: source.data }
      : undefined;
  }
  if (source.type === 'resize') {
    // Un resize fuera de rango se ACOTA, nunca se rechaza. Devolver `undefined` aquí hacía que el
    // llamador cerrase la sesión con protocol_error 4400: una tercera terminal que mandaba rows:1
    // se llevaba puestas las dos que ya estaban vivas (arreglado en prod el 2026-08-24, portado
    // aquí para no revertirlo). Lo que no es un número entero sí sigue siendo un mensaje inválido.
    const geometry = clampTerminalGeometry(source.cols, source.rows);
    return geometry === undefined ? undefined : { type: 'resize', ...geometry };
  }
  if (source.type === 'ping') return { type: 'ping' };
  return undefined;
}

interface ScrollbackChunk {
  readonly start: number;
  readonly end: number;
  readonly data: Buffer;
}

interface ScrollbackEntry {
  chunks: ScrollbackChunk[];
  bytes: number;
  expiresAt: number;
}

export interface SessionManagerOptions {
  readonly gateway: TerminalGatewayClient;
  readonly limits: SessionLimits;
  readonly now?: () => number;
  /** Atomic disk spool for close reports. Omit only in unit tests. */
  readonly closeSpoolFile?: string;
}

export class SessionManager {
  private readonly gateway: TerminalGatewayClient;
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly containers = new Map<string, string>();
  private readonly scrollback = new Map<string, ScrollbackEntry>();
  private readonly pendingReports = new Map<string, Promise<void>>();
  private readonly spooledReports = new Map<string, SessionCloseReport>();
  private readonly closeSpoolFile: string | undefined;

  constructor(options: SessionManagerOptions) {
    this.gateway = options.gateway;
    this.limits = options.limits;
    this.now = options.now ?? Date.now;
    this.closeSpoolFile = options.closeSpoolFile;
    this.loadCloseSpool();
    for (const [sessionId, report] of this.spooledReports) this.startCloseReport(sessionId, report);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** One terminal per destination container: two shells in the same box is a conflict. */
  hasContainerSession(container: string): boolean {
    return this.containers.has(containerKey(container));
  }

  async open(input: OpenSessionInput): Promise<void> {
    this.pruneScrollback();
    if (this.sessions.size >= this.limits.maxSessions) {
      closeSocket(input.socket, CLOSE_CODES.session_conflict, 'session_limit');
      this.reportConsumedClose(input.sessionId, 'session_limit');
      logEvent('terminal_relay_session_rejected', { session_id: input.sessionId, reason: 'session_limit' });
      return;
    }
    const container = containerKey(input.grant.container);
    if (this.sessions.has(input.sessionId) || this.containers.has(container)) {
      closeSocket(input.socket, CLOSE_CODES.session_conflict, 'session_conflict');
      this.reportConsumedClose(input.sessionId, 'session_conflict');
      logEvent('terminal_relay_session_rejected', { session_id: input.sessionId, reason: 'session_conflict' });
      return;
    }
    const session = new TerminalSession(this, this.gateway, this.limits, this.now, input);
    this.sessions.set(input.sessionId, session);
    this.containers.set(container, input.sessionId);
    await session.start(input.queued ?? []);
  }

  /** Rebinds a new browser transport to the PTY that is still alive behind the relay. */
  reattach(input: ReattachSessionInput): boolean {
    const session = this.sessions.get(input.sessionId);
    if (!session || !session.matchesGrant(input.grant)) return false;
    return session.reattach(input);
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
      Promise.allSettled([...this.pendingReports.values()]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
  }

  /** Cierra la fila de un ticket consumido que no alcanzó a convertirse en `TerminalSession`. */
  reportConsumedClose(sessionId: string, reason: string): void {
    const report: SessionCloseReport = { reason, exit_code: null, bytes_in: 0, bytes_out: 0 };
    this.enqueueCloseReport(sessionId, report);
  }

  /** @internal */
  enqueueCloseReport(sessionId: string, report: SessionCloseReport): void {
    if (this.pendingReports.has(sessionId)) return;
    this.spooledReports.set(sessionId, report);
    this.persistCloseSpool();
    this.startCloseReport(sessionId, report);
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

  private startCloseReport(sessionId: string, report: SessionCloseReport): void {
    if (this.pendingReports.has(sessionId)) return;
    const pending = this.retryCloseReport(sessionId, report).finally(() => {
      this.pendingReports.delete(sessionId);
    });
    this.pendingReports.set(sessionId, pending);
  }

  /** Retry forever while the relay lives. Timers are unref'd; the disk spool survives a restart. */
  private async retryCloseReport(sessionId: string, report: SessionCloseReport): Promise<void> {
    let delay = CLOSE_RETRY_MIN_MS;
    for (;;) {
      try {
        await this.gateway.reportClose(sessionId, report);
        this.spooledReports.delete(sessionId);
        this.persistCloseSpool();
        return;
      } catch (error) {
        logEvent('terminal_relay_close_report_retry', {
          session_id: sessionId, delay_ms: delay, error: errorLabel(error)
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      });
      delay = Math.min(CLOSE_RETRY_MAX_MS, delay * 2);
    }
  }

  private loadCloseSpool(): void {
    const path = this.closeSpoolFile;
    if (path === undefined || !existsSync(path)) return;
    const raw = readFileSync(path, 'utf8');
    if (raw.trim().length === 0) return;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('terminal close report spool is invalid');
    }
    const document = parsed as Record<string, unknown>;
    if (document.version !== 1 || !Array.isArray(document.reports) || document.reports.length > 10_000) {
      throw new Error('terminal close report spool has an unsupported shape');
    }
    for (const item of document.reports) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('terminal close report spool contains an invalid report');
      }
      const record = item as Record<string, unknown>;
      if (typeof record.session_id !== 'string' || typeof record.reason !== 'string' ||
          (record.exit_code !== null &&
            (typeof record.exit_code !== 'number' || !Number.isSafeInteger(record.exit_code))) ||
          typeof record.bytes_in !== 'number' || !Number.isSafeInteger(record.bytes_in) || record.bytes_in < 0 ||
          typeof record.bytes_out !== 'number' || !Number.isSafeInteger(record.bytes_out) || record.bytes_out < 0) {
        throw new Error('terminal close report spool contains invalid fields');
      }
      this.spooledReports.set(record.session_id, {
        reason: record.reason,
        exit_code: record.exit_code,
        bytes_in: record.bytes_in,
        bytes_out: record.bytes_out
      });
    }
  }

  /** Atomic, fsync'd snapshot. A duplicate after a crash is harmless because gateway close is idempotent. */
  private persistCloseSpool(): void {
    const path = this.closeSpoolFile;
    if (path === undefined) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    const body = Buffer.from(`${JSON.stringify({
      version: 1,
      reports: [...this.spooledReports].map(([session_id, report]) => ({ session_id, ...report }))
    })}\n`, 'utf8');
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(descriptor, body);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    // fsync del fichero temporal hace durable su contenido, pero no la entrada creada por
    // rename(2). Sin sincronizar el directorio, un corte de energía puede devolver el spool a
    // su nombre/versión anterior y resucitar una plaza fantasma después del restart.
    const directoryDescriptor = openSync(dirname(path), 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}

function containerKey(container: string): string {
  return container;
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
  private socket: WebSocket | undefined;
  private readonly agent: AgentConnection;
  private readonly grant: TerminalSessionGrant;
  private readonly sessionId: string;
  private readonly ticket: string;
  private resumeToken: string;
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
  private resumeReady = false;
  private closed = false;
  private stdin: Buffer[] = [];
  private stdinBytes = 0;
  private outputPaused = false;
  private stdinTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private ttlTimer: NodeJS.Timeout | undefined;
  private authzTimer: NodeJS.Timeout | undefined;
  private windowTimer: NodeJS.Timeout | undefined;
  private drainTimer: NodeJS.Timeout | undefined;
  private openTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
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
    this.resumeToken = input.grant.resume_token;
    this.container = containerKey(input.grant.container);
    this.cols = input.cols;
    this.rows = input.rows;
    this.expiresAtMs = Date.parse(input.grant.session_expires_at);
    this.lastAuthzOkAt = now();
    this.scrollback = manager.scrollbackFor(input.sessionId, this.expiresAtMs);
  }

  async start(queued: readonly QueuedClientMessage[]): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) {
      this.terminate(CLOSE_CODES.internal_error, 'browser_socket_missing');
      return;
    }
    // El browser pudo cerrar entre el consume y este listener. Como el evento ya pasó, el estado
    // es la única señal: no se abre un PTY huérfano y `terminate` reporta el cierre idempotente.
    if (socket.readyState !== WS_OPEN) {
      this.terminate(CLOSE_CODES.normal, 'browser_closed');
      return;
    }
    // Listening from the first synchronous moment: whatever is typed while the agent is opening
    // the PTY is held, not lost, and is replayed in order once the session is ready.
    let ready = false;
    const early: QueuedClientMessage[] = [...queued];
    let earlyBytes = early.reduce((total, message) => total + rawDataByteLength(message.data), 0);
    if (early.length > MAX_EARLY_MESSAGES || earlyBytes > MAX_EARLY_CLIENT_BYTES) {
      this.terminate(CLOSE_CODES.input_flood, 'input_flood');
      return;
    }
    const onEarlyMessage = (data: RawData, isBinary: boolean): void => {
      if (ready) {
        this.onClientMessage(data, isBinary);
        return;
      }
      const bytes = rawDataByteLength(data);
      if (early.length >= MAX_EARLY_MESSAGES || earlyBytes + bytes > MAX_EARLY_CLIENT_BYTES) {
        this.terminate(CLOSE_CODES.input_flood, 'input_flood');
        return;
      }
      early.push({ data, isBinary });
      earlyBytes += bytes;
    };
    socket.on('message', onEarlyMessage);
    this.bindBrowserLifecycle(socket);
    const opened = await this.openOnAgent();
    if (!opened || this.closed) return;
    socket.off('message', onEarlyMessage);
    this.bindReadyBrowser(socket);
    this.sendReady(false, this.bytesOut);
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

  matchesGrant(grant: TerminalSessionGrant): boolean {
    return grant.tenant_id === this.grant.tenant_id && grant.alias === this.grant.alias &&
      grant.container === this.grant.container && grant.runtime_user === this.grant.runtime_user &&
      grant.mode === this.grant.mode && grant.operator_id === this.grant.operator_id &&
      grant.session_expires_at === this.grant.session_expires_at;
  }

  reattach(input: ReattachSessionInput): boolean {
    if (this.closed || this.socket !== undefined || !Number.isSafeInteger(input.afterBytes) || input.afterBytes < 0 ||
        input.afterBytes > this.bytesOut) return false;
    this.socket = input.socket;
    this.resumeToken = input.grant.resume_token;
    this.cols = input.cols;
    this.rows = input.rows;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.bindBrowserLifecycle(input.socket);
    this.bindReadyBrowser(input.socket);
    this.agent.sendResize(this.sessionId, input.cols, input.rows);
    this.sendReady(true, input.afterBytes);
    this.replayScrollback(input.afterBytes);
    for (const message of input.queued ?? []) {
      if (this.closed) break;
      this.onClientMessage(message.data, message.isBinary);
    }
    logEvent('terminal_relay_session_resumed', {
      session_id: this.sessionId, tenant_id: this.grant.tenant_id, alias: this.grant.alias
    });
    return true;
  }

  private bindBrowserLifecycle(socket: WebSocket): void {
    socket.once('close', (code: number) => {
      if (this.socket !== socket || this.closed) return;
      this.socket = undefined;
      if (!this.resumeReady) {
        this.terminate(CLOSE_CODES.normal, 'browser_closed_before_ready');
        return;
      }
      // 1000 is an explicit orderly close, regardless of the client's human-readable reason.
      // Only an abnormal transport loss gets a reconnect grace; trusting one magic reason left
      // old clients' normal closes holding a physical-container slot for the whole grace window.
      if (code === CLOSE_CODES.normal) {
        this.terminate(CLOSE_CODES.normal, 'browser_closed');
        return;
      }
      const grace = this.limits.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.terminate(CLOSE_CODES.going_away, 'reconnect_timeout');
      }, grace);
      this.reconnectTimer.unref?.();
      logEvent('terminal_relay_browser_detached', {
        session_id: this.sessionId, code, reconnect_grace_ms: grace
      });
    });
    socket.on('error', (error: unknown) => {
      logEvent('terminal_relay_browser_socket_error', {
        session_id: this.sessionId, error: errorLabel(error)
      });
    });
  }

  private bindReadyBrowser(socket: WebSocket): void {
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (this.socket === socket) this.onClientMessage(data, isBinary);
    });
  }

  private sendReady(resumed: boolean, streamOffset: number): void {
    this.resumeReady = true;
    this.sendControl({
      type: 'ready',
      session_id: this.sessionId,
      alias: this.grant.alias,
      tenant_id: this.grant.tenant_id,
      container: this.grant.container,
      runtime_user: this.grant.runtime_user,
      mode: this.grant.mode,
      expires_at: this.grant.session_expires_at,
      resumed,
      stream_offset: streamOffset,
      resume_token: this.resumeToken
    });
  }

  terminate(code: number, reason: string, exitCode: number | null = null): void {
    if (this.closed) return;
    this.closed = true;
    if (exitCode !== null) this.exitCode = exitCode;
    this.clearTimers();
    this.stdin = [];
    this.stdinBytes = 0;
    // A teardown mid-handshake must release `start()`, or the attach would hang forever.
    this.settleOpen?.(false);
    this.settleOpen = undefined;
    if (!this.agentClosed && this.agent.alive) this.agent.sendClose(this.sessionId, reason);
    this.agent.detachSession(this.sessionId);
    this.manager.release(this.sessionId, this.container);
    const socket = this.socket;
    if (socket?.readyState === WS_OPEN) {
      this.sendControl({ type: 'closed', reason, exit_code: this.exitCode });
      closeSocket(socket, code, reason);
    }
    this.socket = undefined;
    const report: SessionCloseReport = {
      reason,
      exit_code: this.exitCode,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut
    };
    this.manager.enqueueCloseReport(this.sessionId, report);
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
      if (message.type === 'ping') {
        // En shell la inactividad sigue significando «sin actividad humana». En un visor no puede
        // haber teclado: el ping demuestra que el browser sigue presente sin abrir STDIN.
        if (this.grant.mode === 'harness') this.resetIdle();
        return;
      }
      if (message.type === 'resize') {
        this.cols = message.cols;
        this.rows = message.rows;
        this.agent.sendResize(this.sessionId, message.cols, message.rows);
        return;
      }
      if (message.type === 'terminal_response') {
        // El parser ya validó DA/DSR. Aun así el modo es una segunda frontera: un shell interactivo
        // usa STDIN normal; este canal existe exclusivamente para el viewer harness.
        if (this.grant.mode !== 'harness') {
          this.terminate(CLOSE_CODES.protocol_error, 'terminal_response_forbidden');
          return;
        }
        const response = Buffer.from(message.data, 'ascii');
        this.bytesIn += response.byteLength;
        if (!this.agent.sendTerminalResponse(this.sessionId, response)) {
          this.terminate(CLOSE_CODES.slow_consumer, 'agent_input_backpressure');
        }
        return;
      }
      if (this.grant.mode === 'harness') {
        this.terminate(CLOSE_CODES.protocol_error, 'input_forbidden');
        return;
      }
      const bytes = Buffer.from(message.data, 'utf8');
      if (bytes.byteLength > MAX_INPUT_MESSAGE_BYTES
        || this.stdinBytes + bytes.byteLength > MAX_PENDING_STDIN_BYTES) {
        this.terminate(CLOSE_CODES.input_flood, 'input_flood');
        return;
      }
      this.bytesIn += bytes.byteLength;
      this.stdin.push(bytes);
      this.stdinBytes += bytes.byteLength;
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
    this.stdinBytes = 0;
    try {
      if (!this.agent.sendStdin(this.sessionId, pending)) {
        this.terminate(CLOSE_CODES.input_flood, 'agent_input_backpressure');
      }
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
    // Un harness es una vista: salida real también es actividad, aunque el emulador no tenga que
    // responder nada. Un shell conserva la semántica estricta de input humano.
    if (this.grant.mode === 'harness') this.resetIdle();
    const socket = this.socket;
    if (socket?.readyState !== WS_OPEN) return;
    // PTY output is always binary; control frames are always text. The client splits on that.
    try {
      socket.send(data, { binary: true });
      this.applyBackpressure();
    } catch (error) {
      logEvent('terminal_relay_output_send_failed', { session_id: this.sessionId, error: errorLabel(error) });
      this.terminate(CLOSE_CODES.slow_consumer, 'browser_output_failed');
    }
  }

  /** Bounded, offset-addressed tail used only after gateway-authorized resume of this same PTY. */
  private rememberScrollback(data: Buffer): void {
    const end = this.bytesOut;
    const start = end - data.byteLength;
    this.scrollback.chunks.push({ start, end, data });
    this.scrollback.bytes += data.byteLength;
    const limit = this.limits.scrollbackBytes;
    while (this.scrollback.bytes > limit) {
      const oldest = this.scrollback.chunks[0];
      if (oldest === undefined) break;
      const excess = this.scrollback.bytes - limit;
      if (oldest.data.byteLength <= excess) {
        this.scrollback.chunks.shift();
        this.scrollback.bytes -= oldest.data.byteLength;
        continue;
      }
      this.scrollback.chunks[0] = {
        start: oldest.start + excess,
        end: oldest.end,
        data: oldest.data.subarray(excess)
      };
      this.scrollback.bytes -= excess;
    }
  }

  private replayScrollback(afterBytes: number): void {
    const socket = this.socket;
    if (this.scrollback.bytes === 0 || socket?.readyState !== WS_OPEN || afterBytes >= this.bytesOut) return;
    const first = this.scrollback.chunks[0];
    if (first !== undefined && afterBytes < first.start) {
      this.sendControl({
        type: 'notice', level: 'warn',
        message: 'la desconexión superó el scrollback acotado; se repite únicamente la cola disponible'
      });
    } else {
      this.sendControl({ type: 'notice', level: 'info', message: 'reanudando desde el último byte confirmado' });
    }
    const chunks: Buffer[] = [];
    for (const chunk of this.scrollback.chunks) {
      if (chunk.end <= afterBytes) continue;
      const offset = Math.max(0, afterBytes - chunk.start);
      chunks.push(chunk.data.subarray(offset));
    }
    if (chunks.length > 0) socket.send(Buffer.concat(chunks), { binary: true });
  }

  private applyBackpressure(): void {
    const socket = this.socket;
    if (socket === undefined || socket.bufferedAmount <= BACKPRESSURE_HIGH_BYTES || this.drainTimer !== undefined) return;
    // Un agente viejo no conoce estos tags. Se cierra únicamente el consumidor lento: pausar su
    // TLS multiplexado congelaría PONG, lecturas y todas las demás sesiones.
    if (!this.agent.supportsSessionOutputFlowControl
      || !this.agent.pauseSessionOutput(this.sessionId)) {
      this.terminate(CLOSE_CODES.slow_consumer, 'slow_browser');
      return;
    }
    this.outputPaused = true;
    this.drainTimer = setInterval(() => {
      const activeSocket = this.socket;
      if (this.closed || activeSocket === undefined || activeSocket.bufferedAmount < BACKPRESSURE_LOW_BYTES) {
        if (this.drainTimer) clearInterval(this.drainTimer);
        this.drainTimer = undefined;
        if (!this.closed && this.outputPaused) {
          this.outputPaused = false;
          if (!this.agent.resumeSessionOutput(this.sessionId)) {
            this.terminate(CLOSE_CODES.slow_consumer, 'agent_flow_control_failed');
          }
        }
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
    const socket = this.socket;
    if (socket?.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(message));
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stdinTimer = undefined;
    this.idleTimer = undefined;
    this.ttlTimer = undefined;
    this.authzTimer = undefined;
    this.windowTimer = undefined;
    this.drainTimer = undefined;
    this.openTimer = undefined;
    this.reconnectTimer = undefined;
  }
}
