export interface TelegramLoopObserver {
  pollCycleStarted(alias: string): void;
  pollCycleHeartbeat(alias: string): void;
  pollCycleFenced(alias: string): void;
  pollCycleSucceeded(alias: string, updates: number): void;
  pollCycleFailed(alias: string): void;
  egressCycleStarted(): void;
  egressCycleHeartbeat(): void;
  egressCycleFenced(): void;
  egressCycleSucceeded(events: number): void;
  egressCycleFailed(): void;
}

interface LoopState {
  readonly registeredAt: number;
  readonly staleAfterMs: number;
  runningAt: number | undefined;
  tickAt: number | undefined;
  successAt: number | undefined;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  fenced: number;
  fencedDuringCycle: boolean;
  lastResult: 'success' | 'error' | 'fenced' | undefined;
}

type TelegramHealthReason = 'starting' | 'loop_stale' | 'loop_errors' | 'fenced' | 'ready';

interface TelegramProgressSnapshot {
  readonly live: boolean;
  readonly ready: boolean;
  readonly reason: TelegramHealthReason;
  readonly pollers: number;
  readonly healthy_pollers: number;
  readonly stale_pollers: number;
  readonly fenced_pollers: number;
  readonly egress_configured: boolean;
  readonly egress_stale: boolean;
  readonly egress_fenced: boolean;
}

export function boundedTelegramRequestTimeoutMs(
  pollLeaseMs: number,
  egressLeaseMs: number,
  maximumMs = 65_000,
  safetyMs = 5_000
): number {
  const timeout = Math.min(maximumMs, pollLeaseMs - safetyMs, egressLeaseMs - safetyMs);
  if (![pollLeaseMs, egressLeaseMs, maximumMs, safetyMs, timeout].every(Number.isInteger) ||
      safetyMs < 1 || timeout < 1_000) {
    throw new Error('Telegram request timeout must fit inside poll and egress leases');
  }
  return timeout;
}

function newLoop(now: number, staleAfterMs: number): LoopState {
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1_000) {
    throw new Error('Telegram loop stale deadline is invalid');
  }
  return {
    registeredAt: now, staleAfterMs, runningAt: undefined, tickAt: undefined,
    successAt: undefined, successes: 0, failures: 0, consecutiveFailures: 0,
    fenced: 0, fencedDuringCycle: false, lastResult: undefined
  };
}

function age(loop: LoopState, now: number): number {
  return Math.max(0, now - (loop.runningAt ?? loop.tickAt ?? loop.registeredAt));
}

function stale(loop: LoopState, now: number): boolean {
  return age(loop, now) > loop.staleAfterMs;
}

/**
 * In-memory, boot-local evidence that every poller and the egress loop keeps making attempts.
 * Successful cycles with zero rows/updates count: an actually idle queue must remain healthy.
 * Restart semantics are explicit through process_start_time_seconds and zeroed counters.
 */
export class TelegramBridgeProgress implements TelegramLoopObserver {
  private readonly startedAt: number;
  private readonly pollers = new Map<string, LoopState>();
  private egress: LoopState | undefined;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = this.now();
  }

  registerPoller(alias: string, staleAfterMs: number): void {
    if (this.pollers.has(alias)) throw new Error('Telegram poller was registered twice');
    this.pollers.set(alias, newLoop(this.now(), staleAfterMs));
  }

  registerEgress(staleAfterMs: number): void {
    if (this.egress !== undefined) throw new Error('Telegram egress loop was registered twice');
    this.egress = newLoop(this.now(), staleAfterMs);
  }

  private poller(alias: string): LoopState | undefined {
    return this.pollers.get(alias);
  }

  pollCycleStarted(alias: string): void {
    const loop = this.poller(alias);
    if (loop) {
      loop.runningAt = this.now();
      loop.fencedDuringCycle = false;
    }
  }

  pollCycleHeartbeat(alias: string): void {
    const loop = this.poller(alias);
    if (loop?.runningAt !== undefined) loop.runningAt = this.now();
  }

  pollCycleFenced(alias: string): void {
    const loop = this.poller(alias);
    if (loop) loop.fencedDuringCycle = true;
  }

  pollCycleSucceeded(alias: string, _updates: number): void {
    void _updates;
    const loop = this.poller(alias);
    if (!loop) return;
    const at = this.now();
    loop.runningAt = undefined;
    loop.tickAt = at;
    if (loop.fencedDuringCycle) {
      loop.fenced += 1;
      loop.consecutiveFailures += 1;
      loop.lastResult = 'fenced';
    } else {
      loop.successAt = at;
      loop.successes += 1;
      loop.consecutiveFailures = 0;
      loop.lastResult = 'success';
    }
    loop.fencedDuringCycle = false;
  }

  pollCycleFailed(alias: string): void {
    const loop = this.poller(alias);
    if (!loop) return;
    loop.runningAt = undefined;
    loop.tickAt = this.now();
    loop.failures += 1;
    loop.consecutiveFailures += 1;
    loop.fencedDuringCycle = false;
    loop.lastResult = 'error';
  }

  egressCycleStarted(): void {
    if (this.egress) {
      this.egress.runningAt = this.now();
      this.egress.fencedDuringCycle = false;
    }
  }

  egressCycleHeartbeat(): void {
    if (this.egress?.runningAt !== undefined) this.egress.runningAt = this.now();
  }

  egressCycleFenced(): void {
    if (this.egress) this.egress.fencedDuringCycle = true;
  }

  egressCycleSucceeded(_events: number): void {
    void _events;
    if (!this.egress) return;
    const at = this.now();
    this.egress.runningAt = undefined;
    this.egress.tickAt = at;
    if (this.egress.fencedDuringCycle) {
      this.egress.fenced += 1;
      this.egress.consecutiveFailures += 1;
      this.egress.lastResult = 'fenced';
    } else {
      this.egress.successAt = at;
      this.egress.successes += 1;
      this.egress.consecutiveFailures = 0;
      this.egress.lastResult = 'success';
    }
    this.egress.fencedDuringCycle = false;
  }

  egressCycleFailed(): void {
    if (!this.egress) return;
    this.egress.runningAt = undefined;
    this.egress.tickAt = this.now();
    this.egress.failures += 1;
    this.egress.consecutiveFailures += 1;
    this.egress.fencedDuringCycle = false;
    this.egress.lastResult = 'error';
  }

  snapshot(): TelegramProgressSnapshot {
    const now = this.now();
    const pollers = [...this.pollers.values()];
    const stalePollers = pollers.filter((loop) => stale(loop, now)).length;
    const egressStale = this.egress !== undefined && stale(this.egress, now);
    const fencedPollers = pollers.filter((loop) => loop.lastResult === 'fenced').length;
    const egressFenced = this.egress?.lastResult === 'fenced';
    const starting = pollers.length === 0 || this.egress === undefined ||
      pollers.some((loop) => loop.successes === 0) || this.egress.successes === 0;
    const loopErrors = pollers.some((loop) => loop.consecutiveFailures >= 3) ||
      (this.egress?.consecutiveFailures ?? 0) >= 3;
    const reason: TelegramHealthReason = stalePollers > 0 || egressStale
      ? 'loop_stale'
      : fencedPollers > 0 || egressFenced
        ? 'fenced'
      : loopErrors
        ? 'loop_errors'
        : starting
          ? 'starting'
          : 'ready';
    return {
      live: reason !== 'loop_stale',
      ready: reason === 'ready',
      reason,
      pollers: pollers.length,
      healthy_pollers: pollers.filter((loop) => !stale(loop, now) && loop.lastResult === 'success').length,
      stale_pollers: stalePollers,
      fenced_pollers: fencedPollers,
      egress_configured: this.egress !== undefined,
      egress_stale: egressStale,
      egress_fenced: egressFenced
    };
  }

  renderMetrics(): string {
    const now = this.now();
    const pollers = [...this.pollers.values()];
    const state = this.snapshot();
    const pollSuccesses = pollers.reduce((total, loop) => total + loop.successes, 0);
    const pollFailures = pollers.reduce((total, loop) => total + loop.failures, 0);
    const oldestPollTick = pollers.length === 0
      ? 0
      : Math.min(...pollers.map((loop) => loop.tickAt ?? 0)) / 1_000;
    return [
      '# HELP cauce_telegram_process_start_time_seconds Unix time when this process started; boot-local counters reset here.',
      '# TYPE cauce_telegram_process_start_time_seconds gauge',
      `cauce_telegram_process_start_time_seconds ${String(this.startedAt / 1_000)}`,
      '# HELP cauce_telegram_pollers Number of configured poller loops.',
      '# TYPE cauce_telegram_pollers gauge',
      `cauce_telegram_pollers ${String(pollers.length)}`,
      '# HELP cauce_telegram_pollers_stale Number of poller loops beyond their bounded deadline.',
      '# TYPE cauce_telegram_pollers_stale gauge',
      `cauce_telegram_pollers_stale ${String(state.stale_pollers)}`,
      '# HELP cauce_telegram_poll_ticks_total Boot-local completed poll cycles; idle polls are successful.',
      '# TYPE cauce_telegram_poll_ticks_total counter',
      `cauce_telegram_poll_ticks_total{result="success"} ${String(pollSuccesses)}`,
      `cauce_telegram_poll_ticks_total{result="error"} ${String(pollFailures)}`,
      `cauce_telegram_poll_ticks_total{result="fenced"} ${String(pollers.reduce((total, loop) => total + loop.fenced, 0))}`,
      '# HELP cauce_telegram_oldest_poll_tick_timestamp_seconds Oldest latest poll tick across configured aliases.',
      '# TYPE cauce_telegram_oldest_poll_tick_timestamp_seconds gauge',
      `cauce_telegram_oldest_poll_tick_timestamp_seconds ${String(oldestPollTick)}`,
      '# HELP cauce_telegram_egress_ticks_total Boot-local completed egress claim cycles; idle claims are successful.',
      '# TYPE cauce_telegram_egress_ticks_total counter',
      `cauce_telegram_egress_ticks_total{result="success"} ${String(this.egress?.successes ?? 0)}`,
      `cauce_telegram_egress_ticks_total{result="error"} ${String(this.egress?.failures ?? 0)}`,
      `cauce_telegram_egress_ticks_total{result="fenced"} ${String(this.egress?.fenced ?? 0)}`,
      '# HELP cauce_telegram_egress_last_tick_timestamp_seconds Unix time of the last completed egress claim cycle.',
      '# TYPE cauce_telegram_egress_last_tick_timestamp_seconds gauge',
      `cauce_telegram_egress_last_tick_timestamp_seconds ${String((this.egress?.tickAt ?? 0) / 1_000)}`,
      '# HELP cauce_telegram_egress_loop_stale Whether the egress loop exceeded its bounded cycle deadline.',
      '# TYPE cauce_telegram_egress_loop_stale gauge',
      `cauce_telegram_egress_loop_stale ${state.egress_stale ? '1' : '0'}`,
      // Keep `now` observed so tests can prove a restart has a distinct epoch without a label.
      '# HELP cauce_telegram_health_observed_timestamp_seconds Unix time of this health observation.',
      '# TYPE cauce_telegram_health_observed_timestamp_seconds gauge',
      `cauce_telegram_health_observed_timestamp_seconds ${String(now / 1_000)}`,
      ''
    ].join('\n');
  }
}
