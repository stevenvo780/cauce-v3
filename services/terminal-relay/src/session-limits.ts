import type { RawData, WebSocket } from 'ws';
import type { AgentConnection } from './agent-leg.js';
import {
  CLAIM_DEADLINE_SAFETY_MARGIN_MS,
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  MAX_CLAIM_LEASE_MS,
  claimEpoch,
  isClaimToken,
  type TerminalSessionGrant,
} from './gateway-client.js';

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
export const STDIN_COALESCE_MS = 8;
export const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
export const DEFAULT_OUTPUT_WINDOW_MS = 1_000;
/** Sustained flood: warn after three windows over the limit, close two windows later. */
export const FLOOD_WARN_WINDOWS = 3;
export const FLOOD_CLOSE_WINDOWS = 5;
export const BACKPRESSURE_HIGH_BYTES = 4 * 1024 * 1024;
export const BACKPRESSURE_LOW_BYTES = 1024 * 1024;
export const BACKPRESSURE_POLL_MS = 25;
export const DEFAULT_RECONNECT_GRACE_MS = 30_000;
export const CLOSE_RETRY_MIN_MS = 250;
export const CLOSE_RETRY_MAX_MS = 30_000;
/** Frames held while the agent opens the PTY; a client flooding that window is not typing. */
export const MAX_EARLY_MESSAGES = 64;
export const MAX_INPUT_MESSAGE_BYTES = 16 * 1024;
export const MAX_PENDING_STDIN_BYTES = 64 * 1024;
/** Includes JSON overhead and control frames while OPEN is in flight. */
export const MAX_EARLY_CLIENT_BYTES = 128 * 1024;
export const WS_OPEN = 1;

export interface SessionLimits {
  readonly idleTimeoutMs: number;
  readonly outputRateBytesPerSec: number;
  readonly scrollbackBytes: number;
  readonly maxSessions: number;
  readonly authzIntervalMs: number;
  readonly authzGraceMs: number;
  /** Configured nominal gateway lease; production rejects rollout skew instead of guessing. */
  readonly expectedClaimLeaseMs?: number;
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
  /** Monotonic instant immediately before the claim-bearing gateway request began. */
  readonly claimRequestStartedAt?: number;
  /** Client frames that arrived while the gateway was being consulted. */
  readonly queued?: readonly QueuedClientMessage[];
}

export interface ReattachSessionInput {
  readonly socket: WebSocket;
  readonly sessionId: string;
  readonly grant: TerminalSessionGrant;
  readonly cols: number;
  readonly rows: number;
  /** Monotonic instant immediately before the exact-fence renewal began. */
  readonly claimRequestStartedAt?: number;
  /** Number of PTY output bytes the browser already received before the transport broke. */
  readonly afterBytes: number;
  readonly queued?: readonly QueuedClientMessage[];
}

export type ClientMessage =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'terminal_response'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'ping' };

/** Closed set that xterm 5.5 emits for DA/DSR; any other sequence fails closed. */
export const MAX_TERMINAL_RESPONSE_BYTES = 256;
const PRIMARY_DA = '\x1b[?1;2c';
const SECONDARY_DA = '\x1b[>0;276;0c';
const STATUS_DSR = '\x1b[0n';

/** A truly finite integer: rejects NaN, Infinity, decimals and anything that is not a number. */
function isEnteroFinito(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Clamps `value` to the [minimum, maximum] range instead of rejecting it. */
function acotar(valor: number, minimo: number, maximo: number): number {
  return Math.min(maximo, Math.max(minimo, valor));
}

function positiveDecimal(value: string): boolean {
  if (value.length === 0 || value.length > 3 || value.startsWith('0')) return false;
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

/** Out-of-range integers are clamped the same in attach and resize; other types are invalid protocol. */
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
    // An out-of-range resize is clamped. Anything that is not an integer is an invalid message.
    const geometry = clampTerminalGeometry(source.cols, source.rows);
    return geometry === undefined ? undefined : { type: 'resize', ...geometry };
  }
  if (source.type === 'ping') return { type: 'ping' };
  return undefined;
}

export interface ScrollbackChunk {
  readonly start: number;
  readonly end: number;
  readonly data: Buffer;
}

export interface ScrollbackEntry {
  chunks: ScrollbackChunk[];
  bytes: number;
  expiresAt: number;
}

/**
 * A lease must outlive one complete failed revalidation cycle, its fail-closed grace and the
 * gateway timeout, with a final margin in which the local PTY is guaranteed to die before a
 * different relay can take the row over. The nominal TTL is used for this configuration check;
 * the remaining lease is separately checked for each response.
 */
export function claimLeaseContractSatisfied(
  grant: TerminalSessionGrant,
  limits: SessionLimits,
): boolean {
  return isClaimToken(grant.claim_token)
    && claimEpoch(grant.claim_epoch) !== undefined
    && Number.isSafeInteger(grant.claim_lease_ms)
    && grant.claim_lease_ms > CLAIM_DEADLINE_SAFETY_MARGIN_MS
    && grant.claim_lease_ms <= MAX_CLAIM_LEASE_MS
    && claimLeaseTtlSatisfied(grant.claim_lease_ttl_ms, limits)
    && grant.claim_lease_ms <= grant.claim_lease_ttl_ms;
}

export function claimLeaseTtlSatisfied(ttlMs: number, limits: SessionLimits): boolean {
  const requiredMs = limits.authzIntervalMs + limits.authzGraceMs
    + DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + CLAIM_DEADLINE_SAFETY_MARGIN_MS;
  return Number.isSafeInteger(ttlMs) && ttlMs > requiredMs && ttlMs <= MAX_CLAIM_LEASE_MS
    && (limits.expectedClaimLeaseMs === undefined || ttlMs === limits.expectedClaimLeaseMs);
}

export function containerKey(container: string): string {
  return container;
}

export function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    // A socket that is already gone needs no closing.
  }
}
