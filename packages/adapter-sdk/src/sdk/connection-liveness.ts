import { AdapterError } from './errors.js';
import type { AdapterConfig, Clock, ConsumerConnection, TimerHandle } from './types.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_HELLO_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_SEND_TIMEOUT_MS = 15_000;
const MIN_DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS = 30_000;
const LEASE_EXPIRY_SAFETY_MS = 1_000;
export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export interface ConnectionTimeouts {
  readonly connectMs: number;
  readonly helloAckMs: number;
  readonly heartbeatAckMs: number;
  readonly sendMs: number;
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_NODE_TIMER_DELAY_MS) {
    throw new RangeError(
      `${name} must be a positive integer no greater than ${String(MAX_NODE_TIMER_DELAY_MS)}`,
    );
  }
  return value;
}

export function connectionTimeouts(config: AdapterConfig): ConnectionTimeouts {
  const heartbeatMs = config.heartbeatMs ?? 15_000;
  return {
    connectMs: positiveTimeout(
      config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs',
    ),
    helloAckMs: positiveTimeout(
      config.helloAckTimeoutMs ?? DEFAULT_HELLO_ACK_TIMEOUT_MS,
      'helloAckTimeoutMs',
    ),
    heartbeatAckMs: positiveTimeout(
      config.heartbeatAckTimeoutMs
        ?? Math.max(MIN_DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS, heartbeatMs * 2),
      'heartbeatAckTimeoutMs',
    ),
    sendMs: positiveTimeout(config.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS, 'sendTimeoutMs'),
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Operation aborted', { cause: signal.reason });
}

interface DeadlineOptions {
  readonly clock: Clock;
  readonly at: number;
  readonly signals?: readonly AbortSignal[];
  readonly timeoutError: () => Error;
}

/** Races an already-started operation without leaving a timer or abort listener behind. */
export async function raceWithDeadline<T>(
  operation: Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const signals = [...new Set(options.signals ?? [])];
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted !== undefined) throw abortError(aborted);

  const remainingMs = options.at - options.clock.now().getTime();
  if (remainingMs <= 0) throw options.timeoutError();

  let timer: TimerHandle | undefined;
  const listeners: { readonly signal: AbortSignal; readonly abort: () => void }[] = [];
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = options.clock.setTimer(() => { reject(options.timeoutError()); }, remainingMs);
    for (const signal of signals) {
      const abort = (): void => { reject(abortError(signal)); };
      listeners.push({ signal, abort });
      signal.addEventListener('abort', abort, { once: true });
    }
  });

  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (timer !== undefined) options.clock.clearTimer(timer);
    for (const listener of listeners) {
      listener.signal.removeEventListener('abort', listener.abort);
    }
  }
}

export async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => { reject(abortError(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => iterator.next()),
      aborted,
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

export function releaseIteratorWithoutWaiting<T>(iterator: AsyncIterator<T>): void {
  try {
    const completion = iterator.return?.();
    if (completion !== undefined) void Promise.resolve(completion).catch(() => undefined);
  } catch {
    return;
  }
}

export function closeConnectionWithoutWaiting(connection: ConsumerConnection | undefined): void {
  if (connection === undefined) return;
  try {
    void Promise.resolve(connection.close()).catch(() => undefined);
  } catch {
    return;
  }
}

interface ConnectionLivenessOptions {
  readonly clock: Clock;
  readonly helloAckTimeoutMs: number;
  readonly heartbeatAckTimeoutMs: number;
  readonly onFailure: (error: AdapterError) => void;
}

/** Owns liveness timers for exactly one transport generation. */
export class ConnectionLiveness {
  private helloTimer: TimerHandle | undefined;
  private heartbeatTimer: TimerHandle | undefined;
  private leaseTimer: TimerHandle | undefined;
  private leaseExpiresAt = Number.NEGATIVE_INFINITY;
  private lastHeartbeatAckLease: number | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly options: ConnectionLivenessOptions) {}

  start(): void {
    if (this.started) throw new Error('Connection liveness was already started');
    this.started = true;
    this.helloTimer = this.options.clock.setTimer(() => {
      this.fail(new AdapterError(
        'HELLO_ACK_TIMEOUT',
        'Gateway did not acknowledge hello before the connection deadline',
        true,
      ));
    }, this.options.helloAckTimeoutMs);
  }

  helloAcknowledged(leaseExpiresAt: string): void {
    if (this.stopped) return;
    this.clearHelloTimer();
    const parsed = this.parseLeaseExpiry(leaseExpiresAt);
    if (parsed === undefined) return;
    this.lastHeartbeatAckLease = parsed;
    this.extendParsedLease(parsed);
  }

  heartbeatStarted(): void {
    if (this.stopped || this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = this.options.clock.setTimer(() => {
      this.fail(new AdapterError(
        'HEARTBEAT_ACK_TIMEOUT',
        'Gateway did not acknowledge a heartbeat before the connection deadline',
        true,
      ));
    }, this.options.heartbeatAckTimeoutMs);
  }

  heartbeatAcknowledged(leaseExpiresAt: string): boolean {
    if (this.stopped) return false;
    const parsed = this.parseLeaseExpiry(leaseExpiresAt);
    if (parsed === undefined) return false;
    if (this.lastHeartbeatAckLease !== undefined && parsed <= this.lastHeartbeatAckLease) {
      return false;
    }
    this.lastHeartbeatAckLease = parsed;
    this.clearHeartbeatTimer();
    this.extendParsedLease(parsed);
    return true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
  }

  private parseLeaseExpiry(value: string): number | undefined {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    this.fail(new AdapterError(
      'INVALID_LEASE_EXPIRY',
      'Gateway supplied an invalid connection lease expiry',
      true,
    ));
    return undefined;
  }

  private extendParsedLease(expiresAt: number): void {
    if (this.stopped || expiresAt <= this.leaseExpiresAt) return;
    this.leaseExpiresAt = expiresAt;
    if (this.leaseTimer !== undefined) this.options.clock.clearTimer(this.leaseTimer);
    this.leaseTimer = undefined;
    const remainingMs = expiresAt - this.options.clock.now().getTime();
    // A received ACK proves current traffic; a near/past absolute timestamp may instead be clock skew.
    if (remainingMs <= LEASE_EXPIRY_SAFETY_MS) return;
    this.armLeaseTimer(expiresAt);
  }

  private armLeaseTimer(expiresAt: number): void {
    if (this.stopped || expiresAt !== this.leaseExpiresAt) return;
    const remainingMs = expiresAt
      - LEASE_EXPIRY_SAFETY_MS
      - this.options.clock.now().getTime();
    if (remainingMs <= 0) return;
    this.leaseTimer = this.options.clock.setTimer(() => {
      this.leaseTimer = undefined;
      if (this.stopped || expiresAt !== this.leaseExpiresAt) return;
      if (expiresAt - LEASE_EXPIRY_SAFETY_MS > this.options.clock.now().getTime()) {
        this.armLeaseTimer(expiresAt);
        return;
      }
      this.fail(new AdapterError(
        'CONNECTION_LEASE_EXPIRED',
        'Gateway connection lease approached expiry without a confirmed renewal',
        true,
      ));
    }, Math.min(remainingMs, MAX_NODE_TIMER_DELAY_MS));
  }

  private fail(error: AdapterError): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.options.onFailure(error);
  }

  private clearHelloTimer(): void {
    if (this.helloTimer === undefined) return;
    this.options.clock.clearTimer(this.helloTimer);
    this.helloTimer = undefined;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer === undefined) return;
    this.options.clock.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearTimers(): void {
    this.clearHelloTimer();
    this.clearHeartbeatTimer();
    if (this.leaseTimer !== undefined) this.options.clock.clearTimer(this.leaseTimer);
    this.leaseTimer = undefined;
  }
}
