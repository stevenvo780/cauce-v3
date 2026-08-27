export type ShadowRouterHealthReason =
  | 'starting'
  | 'loop_stale'
  | 'repository_error'
  | 'target_error'
  | 'stopping'
  | 'ready';

export interface ShadowRouterProgressSnapshot {
  readonly live: boolean;
  readonly ready: boolean;
  readonly reason: ShadowRouterHealthReason;
  readonly cycle_running: boolean;
  readonly successful_cycles: number;
  readonly failed_cycles: number;
  readonly target_failed_cycles: number;
  readonly claimed_events: number;
  readonly routed_events: number;
  readonly failed_events: number;
  readonly released_events: number;
  readonly aborted_cycles: number;
  readonly tick_age_ms: number;
  readonly success_age_ms: number | null;
}

/**
 * Evidencia de progreso del worker, local al arranque.
 *
 * Un claim vacío es progreso real mientras nunca haya fallado el destino. Después de un fallo
 * de ruteo, en cambio, los claims vacíos sólo prueban PostgreSQL: no prueban que el socket de
 * destino se recuperó. Ese estado queda rojo hasta que una entrega sea ruteada de punta a punta.
 */
export class ShadowRouterProgress {
  private readonly startedAt: number;
  private cycleStartedAt: number | undefined;
  private lastTickAt: number | undefined;
  private lastSuccessAt: number | undefined;
  private successfulCycles = 0;
  private failedCycles = 0;
  private targetFailedCycles = 0;
  private claimedEvents = 0;
  private routedEvents = 0;
  private failedEvents = 0;
  private releasedEvents = 0;
  private abortedCycles = 0;
  private targetFailureLatched = false;
  private isStopping = false;
  private lastCycle: 'success' | 'repository_error' | undefined;

  constructor(
    private readonly staleAfterMs: number,
    private readonly now: () => number = Date.now,
  ) {
    // El request al target tiene un timeout de 15 s. El stale gate tiene que dejar además
    // margen para persistir el resultado/retry sin declarar muerto un ciclo todavía acotado.
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 20_000) {
      throw new Error('SHADOW_ROUTER_HEALTH_STALE_MS must be an integer of at least 20000');
    }
    this.startedAt = this.now();
  }

  cycleStarted(): void {
    this.cycleStartedAt = this.now();
  }

  /** A durable per-event settlement keeps a valid long batch from looking like a hung request. */
  eventSettled(): void {
    if (this.cycleStartedAt === undefined) throw new Error('shadow router event settled outside a cycle');
    this.lastTickAt = this.now();
  }

  cycleCompleted(result: { claimed: number; routed: number; failed: number; released?: number }): void {
    const released = result.released ?? 0;
    if (![result.claimed, result.routed, result.failed, released].every(Number.isSafeInteger)
      || result.claimed < 0 || result.routed < 0 || result.failed < 0 || released < 0
      || result.routed + result.failed + released !== result.claimed) {
      throw new Error('shadow router cycle result is inconsistent');
    }
    const at = this.now();
    this.lastTickAt = at;
    this.cycleStartedAt = undefined;
    this.claimedEvents += result.claimed;
    this.routedEvents += result.routed;
    this.failedEvents += result.failed;
    this.releasedEvents += released;
    this.lastCycle = 'success';
    if (released > 0) {
      // A route rejected before the target boundary. Its inbox attempt was restored safely, but
      // readiness must remain red until the repository/input condition has actually recovered.
      this.failedCycles += 1;
      this.lastCycle = 'repository_error';
      return;
    }
    if (result.failed > 0) {
      this.targetFailedCycles += 1;
      this.targetFailureLatched = true;
      return;
    }
    this.successfulCycles += 1;
    // Un tick vacío no demuestra que el target volvió. Una entrega realmente ruteada sí.
    if (result.routed > 0) this.targetFailureLatched = false;
    if (!this.targetFailureLatched) this.lastSuccessAt = at;
  }

  cycleFailed(): void {
    this.lastTickAt = this.now();
    this.cycleStartedAt = undefined;
    this.failedCycles += 1;
    this.lastCycle = 'repository_error';
  }

  cycleAborted(result: { claimed: number; routed: number; failed: number; released: number }): void {
    if (![result.claimed, result.routed, result.failed, result.released].every(Number.isSafeInteger)
      || result.claimed < 0 || result.routed < 0 || result.failed < 0 || result.released < 0
      || result.routed + result.failed + result.released !== result.claimed) {
      throw new Error('shadow router aborted cycle result is inconsistent');
    }
    const at = this.now();
    this.lastTickAt = at;
    this.cycleStartedAt = undefined;
    this.claimedEvents += result.claimed;
    this.routedEvents += result.routed;
    this.failedEvents += result.failed;
    this.releasedEvents += result.released;
    this.abortedCycles += 1;
    this.isStopping = true;
  }

  stopping(): void {
    this.isStopping = true;
    this.lastTickAt = this.now();
  }

  snapshot(): ShadowRouterProgressSnapshot {
    const at = this.now();
    const progressAt = Math.max(this.startedAt, this.cycleStartedAt ?? 0, this.lastTickAt ?? 0);
    const tickAge = Math.max(0, at - progressAt);
    const stale = tickAge > this.staleAfterMs;
    // Merely entering claim() is not evidence of a successful cycle.  Keep `starting` until a
    // cycle has actually settled, while still turning a hung first cycle into `loop_stale`.
    const started = this.successfulCycles + this.failedCycles + this.targetFailedCycles > 0;
    const reason: ShadowRouterHealthReason = this.isStopping
      ? 'stopping'
      : stale
      ? 'loop_stale'
      : !started
        ? 'starting'
        : this.lastCycle === 'repository_error'
          ? 'repository_error'
          : this.targetFailureLatched
            ? 'target_error'
            : 'ready';
    return {
      live: !stale,
      ready: reason === 'ready',
      reason,
      cycle_running: this.cycleStartedAt !== undefined,
      successful_cycles: this.successfulCycles,
      failed_cycles: this.failedCycles,
      target_failed_cycles: this.targetFailedCycles,
      claimed_events: this.claimedEvents,
      routed_events: this.routedEvents,
      failed_events: this.failedEvents,
      released_events: this.releasedEvents,
      aborted_cycles: this.abortedCycles,
      tick_age_ms: tickAge,
      success_age_ms: this.lastSuccessAt === undefined ? null : Math.max(0, at - this.lastSuccessAt),
    };
  }

  renderMetrics(): string {
    const state = this.snapshot();
    return `${[
      '# HELP cauce_shadow_router_process_start_time_seconds Unix time when this process started.',
      '# TYPE cauce_shadow_router_process_start_time_seconds gauge',
      `cauce_shadow_router_process_start_time_seconds ${this.startedAt / 1_000}`,
      '# HELP cauce_shadow_router_loop_ticks_total Boot-local completed worker cycles.',
      '# TYPE cauce_shadow_router_loop_ticks_total counter',
      `cauce_shadow_router_loop_ticks_total{result="success"} ${this.successfulCycles}`,
      `cauce_shadow_router_loop_ticks_total{result="repository_error"} ${this.failedCycles}`,
      `cauce_shadow_router_loop_ticks_total{result="target_error"} ${this.targetFailedCycles}`,
      `cauce_shadow_router_loop_ticks_total{result="aborted"} ${this.abortedCycles}`,
      '# HELP cauce_shadow_router_events_processed_total Boot-local claimed event outcomes.',
      '# TYPE cauce_shadow_router_events_processed_total counter',
      `cauce_shadow_router_events_processed_total{result="routed"} ${this.routedEvents}`,
      `cauce_shadow_router_events_processed_total{result="failed"} ${this.failedEvents}`,
      `cauce_shadow_router_events_processed_total{result="released_unstarted"} ${this.releasedEvents}`,
      '# HELP cauce_shadow_router_loop_stale Whether the worker exceeded its bounded progress deadline.',
      '# TYPE cauce_shadow_router_loop_stale gauge',
      `cauce_shadow_router_loop_stale ${state.reason === 'loop_stale' ? 1 : 0}`,
      '# HELP cauce_shadow_router_ready Whether database claims and the last required target delivery are verified.',
      '# TYPE cauce_shadow_router_ready gauge',
      `cauce_shadow_router_ready ${state.ready ? 1 : 0}`,
      '',
    ].join('\n')}`;
  }
}
