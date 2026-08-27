import type { OriginRelayResult } from './types.js';

export type RelayHealthReason =
  | 'starting'
  | 'no_adapters'
  | 'loop_stale'
  | 'fenced_ack'
  | 'repository_errors'
  | 'ready';

export interface RelayProgressSnapshot {
  readonly live: boolean;
  readonly ready: boolean;
  readonly reason: RelayHealthReason;
  readonly configured_adapters: number;
  readonly cycle_running: boolean;
  readonly successful_cycles: number;
  readonly failed_cycles: number;
  readonly fenced_cycles: number;
  readonly consecutive_failures: number;
  readonly tick_age_ms: number | null;
  readonly success_age_ms: number | null;
}

export function assertRelayLeaseCoversSend(leaseMs: number, sendDeadlineMs: number, safetyMs = 5_000): void {
  if (!Number.isInteger(leaseMs) || !Number.isInteger(sendDeadlineMs) || !Number.isInteger(safetyMs) ||
      sendDeadlineMs < 1 || safetyMs < 1 || leaseMs < sendDeadlineMs + safetyMs) {
    throw new Error('CAUCE_RELAY_LEASE_MS must exceed the total webhook deadline by the ACK safety margin');
  }
}

/**
 * Boot-local loop evidence.
 *
 * An idle claim is a successful tick: no queued work is a legitimate healthy state. A started
 * cycle only counts as progress until `staleAfterMs`; after that a stuck repository/transport
 * makes liveness and readiness red even though the Node process and PostgreSQL may still exist.
 * Counters intentionally reset on restart and are paired with process_start_time_seconds.
 */
export class OriginRelayProgress {
  private readonly startedAt: number;
  private readonly outcomes = new Map<OriginRelayResult, number>();
  private cycleStartedAt: number | undefined;
  private lastTickAt: number | undefined;
  private lastSuccessAt: number | undefined;
  private successfulCycles = 0;
  private failedCycles = 0;
  private fencedCycles = 0;
  private consecutiveFailures = 0;
  private fencedDuringCycle = false;
  private lastCycle: 'success' | 'error' | 'fenced' | undefined;

  constructor(
    private readonly configuredAdapters: number,
    private readonly staleAfterMs: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(configuredAdapters) || configuredAdapters < 0 ||
        !Number.isFinite(staleAfterMs) || staleAfterMs < 1_000) {
      throw new Error('origin relay progress options are invalid');
    }
    this.startedAt = this.now();
  }

  cycleStarted(): void {
    this.cycleStartedAt = this.now();
    this.fencedDuringCycle = false;
  }

  cycleSucceeded(): void {
    const at = this.now();
    this.lastTickAt = at;
    this.cycleStartedAt = undefined;
    if (this.fencedDuringCycle) {
      this.fencedCycles += 1;
      this.consecutiveFailures += 1;
      this.lastCycle = 'fenced';
    } else {
      this.lastSuccessAt = at;
      this.successfulCycles += 1;
      this.consecutiveFailures = 0;
      this.lastCycle = 'success';
    }
    this.fencedDuringCycle = false;
  }

  cycleFailed(): void {
    this.lastTickAt = this.now();
    this.cycleStartedAt = undefined;
    this.failedCycles += 1;
    this.consecutiveFailures += 1;
    this.fencedDuringCycle = false;
    this.lastCycle = 'error';
  }

  result(outcome: OriginRelayResult): void {
    this.outcomes.set(outcome, (this.outcomes.get(outcome) ?? 0) + 1);
    if (outcome === 'fenced') this.fencedDuringCycle = true;
  }

  snapshot(): RelayProgressSnapshot {
    const at = this.now();
    const progressAt = this.cycleStartedAt ?? this.lastTickAt;
    const tickAge = progressAt === undefined ? at - this.startedAt : at - progressAt;
    const stale = tickAge > this.staleAfterMs;
    const started = this.successfulCycles + this.failedCycles > 0 || this.cycleStartedAt !== undefined;
    const reason: RelayHealthReason = this.configuredAdapters === 0
      ? 'no_adapters'
      : stale
        ? 'loop_stale'
        : this.lastCycle === 'fenced'
          ? 'fenced_ack'
          : !started || this.successfulCycles === 0
          ? 'starting'
          : this.consecutiveFailures >= 3
            ? 'repository_errors'
            : 'ready';
    return {
      live: !stale,
      ready: reason === 'ready',
      reason,
      configured_adapters: this.configuredAdapters,
      cycle_running: this.cycleStartedAt !== undefined,
      successful_cycles: this.successfulCycles,
      failed_cycles: this.failedCycles,
      fenced_cycles: this.fencedCycles,
      consecutive_failures: this.consecutiveFailures,
      tick_age_ms: Math.max(0, tickAge),
      success_age_ms: this.lastSuccessAt === undefined ? null : Math.max(0, at - this.lastSuccessAt)
    };
  }

  renderMetrics(): string {
    const snapshot = this.snapshot();
    const timestamp = (this.lastTickAt ?? 0) / 1_000;
    const lastSuccess = (this.lastSuccessAt ?? 0) / 1_000;
    const lines = [
      '# HELP cauce_origin_relay_process_start_time_seconds Unix time when this process started; boot-local counters reset here.',
      '# TYPE cauce_origin_relay_process_start_time_seconds gauge',
      `cauce_origin_relay_process_start_time_seconds ${this.startedAt / 1_000}`,
      '# HELP cauce_origin_relay_configured_adapters Number of explicitly configured adapters.',
      '# TYPE cauce_origin_relay_configured_adapters gauge',
      `cauce_origin_relay_configured_adapters ${this.configuredAdapters}`,
      '# HELP cauce_origin_relay_loop_ticks_total Boot-local completed claim cycles.',
      '# TYPE cauce_origin_relay_loop_ticks_total counter',
      `cauce_origin_relay_loop_ticks_total{result="success"} ${this.successfulCycles}`,
      `cauce_origin_relay_loop_ticks_total{result="error"} ${this.failedCycles}`,
      `cauce_origin_relay_loop_ticks_total{result="fenced"} ${this.fencedCycles}`,
      '# HELP cauce_origin_relay_last_tick_timestamp_seconds Unix time of the last completed claim cycle.',
      '# TYPE cauce_origin_relay_last_tick_timestamp_seconds gauge',
      `cauce_origin_relay_last_tick_timestamp_seconds ${timestamp}`,
      '# HELP cauce_origin_relay_last_success_timestamp_seconds Unix time of the last successful claim cycle, including idle cycles.',
      '# TYPE cauce_origin_relay_last_success_timestamp_seconds gauge',
      `cauce_origin_relay_last_success_timestamp_seconds ${lastSuccess}`,
      '# HELP cauce_origin_relay_loop_stale Whether the worker loop has exceeded its bounded cycle deadline.',
      '# TYPE cauce_origin_relay_loop_stale gauge',
      `cauce_origin_relay_loop_stale ${snapshot.reason === 'loop_stale' ? 1 : 0}`,
      '# HELP cauce_origin_relay_results_total Boot-local fenced durable outcomes; sent increments only after an applied ACK.',
      '# TYPE cauce_origin_relay_results_total counter',
      ...(['sent', 'retry', 'dead', 'fenced'] as const).map((result) =>
        `cauce_origin_relay_results_total{result="${result}"} ${this.outcomes.get(result) ?? 0}`),
      ''
    ];
    return lines.join('\n');
  }
}
