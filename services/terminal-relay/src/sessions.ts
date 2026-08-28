import { performance } from 'node:perf_hooks';
import {
  claimEpoch,
  isClaimToken,
  type SessionCloseReport,
  type TerminalGatewayClient,
  type TerminalSessionGrant,
} from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';
import {
  SessionManagerDelegate,
  TerminalSession,
} from './session-instance.js';
import {
  CLOSE_CODES,
  CLOSE_RETRY_MAX_MS,
  CLOSE_RETRY_MIN_MS,
  claimLeaseContractSatisfied,
  closeSocket,
  containerKey,
  type OpenSessionInput,
  type ReattachSessionInput,
  type ScrollbackEntry,
  type SessionLimits,
} from './session-limits.js';
import {
  loadCloseSpool,
  persistCloseSpool,
} from './session-spool.js';

export * from './session-limits.js';
export * from './session-instance.js';

export interface SessionManagerOptions {
  readonly gateway: TerminalGatewayClient;
  readonly limits: SessionLimits;
  readonly now?: () => number;
  /** Monotonic clock used only for ownership-lease deadlines. */
  readonly monotonicNow?: () => number;
  /** Atomic disk spool for close reports. Omit only in unit tests. */
  readonly closeSpoolFile?: string;
}

export class SessionManager implements SessionManagerDelegate {
  private readonly gateway: TerminalGatewayClient;
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
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
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.closeSpoolFile = options.closeSpoolFile;
    loadCloseSpool(this.closeSpoolFile, this.spooledReports);
    for (const [sessionId, report] of this.spooledReports) this.startCloseReport(sessionId, report);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** One terminal per destination container: two shells in the same box is a conflict. */
  hasContainerSession(container: string): boolean {
    return this.containers.has(containerKey(container));
  }

  /** Exact local ownership check; unlike the container index it cannot confuse a replay with a peer. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Raw fence stays private to the local relay; browser-provided copies are never authority. */
  claimForSession(sessionId: string): { readonly token: string; readonly epoch: string } | undefined {
    return this.sessions.get(sessionId)?.claimFence();
  }

  async open(input: OpenSessionInput): Promise<void> {
    this.pruneScrollback();
    // A recovered consume receipt can arrive while the first attach already owns this sid. The
    // duplicate never owned a local PTY, so reporting `/close` here would tear down the winner.
    if (this.sessions.has(input.sessionId)) {
      closeSocket(input.socket, CLOSE_CODES.session_conflict, 'session_conflict');
      logEvent('terminal_relay_session_rejected', {
        session_id: input.sessionId,
        reason: 'session_already_active',
      });
      return;
    }
    if (!claimLeaseContractSatisfied(input.grant, this.limits)) {
      closeSocket(input.socket, CLOSE_CODES.revoked, 'claim_lease_invalid');
      if (isClaimToken(input.grant.claim_token) && claimEpoch(input.grant.claim_epoch) !== undefined) {
        this.reportConsumedClose(input.sessionId, 'claim_lease_invalid', input.grant);
      }
      logEvent('terminal_relay_session_rejected', {
        session_id: input.sessionId,
        reason: 'claim_lease_invalid',
      });
      return;
    }
    if (this.sessions.size >= this.limits.maxSessions) {
      closeSocket(input.socket, CLOSE_CODES.session_conflict, 'session_limit');
      this.reportConsumedClose(input.sessionId, 'session_limit', input.grant);
      logEvent('terminal_relay_session_rejected', { session_id: input.sessionId, reason: 'session_limit' });
      return;
    }
    const container = containerKey(input.grant.container);
    if (this.containers.has(container)) {
      closeSocket(input.socket, CLOSE_CODES.session_conflict, 'session_conflict');
      this.reportConsumedClose(input.sessionId, 'session_conflict', input.grant);
      logEvent('terminal_relay_session_rejected', { session_id: input.sessionId, reason: 'session_conflict' });
      return;
    }
    const session = new TerminalSession(
      this, this.gateway, this.limits, this.now, this.monotonicNow, input,
    );
    this.sessions.set(input.sessionId, session);
    this.containers.set(container, input.sessionId);
    try {
      await session.start(input.queued ?? []);
    } catch (error) {
      // `TerminalSession` handles protocol/open failures internally. This guard covers an
      // unexpected synchronous collaborator failure after the manager acquired both indexes.
      logEvent('terminal_relay_session_start_failed', {
        session_id: input.sessionId,
        error: errorLabel(error),
      });
      session.terminate(CLOSE_CODES.internal_error, 'open_failed');
    }
  }

  /** Rebinds a new browser transport to the PTY that is still alive behind the relay. */
  reattach(input: ReattachSessionInput): boolean {
    const session = this.sessions.get(input.sessionId);
    if (!session || !claimLeaseContractSatisfied(input.grant, this.limits)
        || !session.matchesGrant(input.grant)) return false;
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
        timer.unref();
      })
    ]);
  }

  /** Cierra la fila de un ticket consumido que no alcanzó a convertirse en `TerminalSession`. */
  reportConsumedClose(sessionId: string, reason: string, grant: TerminalSessionGrant): void {
    const report: SessionCloseReport = {
      reason,
      exit_code: null,
      bytes_in: 0,
      bytes_out: 0,
      claim_token: grant.claim_token,
      claim_epoch: grant.claim_epoch,
    };
    this.enqueueCloseReport(sessionId, report);
  }

  /** @internal */
  enqueueCloseReport(sessionId: string, report: SessionCloseReport): void {
    if (this.pendingReports.has(sessionId)) return;
    this.spooledReports.set(sessionId, report);
    persistCloseSpool(this.closeSpoolFile, this.spooledReports);
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
        persistCloseSpool(this.closeSpoolFile, this.spooledReports);
        return;
      } catch (error) {
        logEvent('terminal_relay_close_report_retry', {
          session_id: sessionId, delay_ms: delay, error: errorLabel(error)
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref();
      });
      delay = Math.min(CLOSE_RETRY_MAX_MS, delay * 2);
    }
  }
}
