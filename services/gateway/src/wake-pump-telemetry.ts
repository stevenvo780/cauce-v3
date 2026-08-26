export type WakePumpOutcome = 'sent' | 'retry' | 'dead' | 'fenced' | 'error' | 'cancelled';

export interface WakePumpTelemetrySnapshot {
  readonly state: 'idle' | 'running' | 'stopping';
  readonly lastProgressAtMs: number | null;
  /** Last cycle with no fenced/error outcome. Progress alone can be a tight failing loop. */
  readonly lastSuccessAtMs: number | null;
  readonly consecutiveFailures: number;
  readonly counters: Readonly<{
    cycles: number;
    claimed: number;
    sent: number;
    retry: number;
    dead: number;
    fenced: number;
    error: number;
    cancelled: number;
  }>;
}

/**
 * Estado agregado y pull-friendly del pump. Deliberadamente no acepta labels ni identidades:
 * puede exponerse como métrica sin filtrar tenants, aliases, IDs de evento o tokens de claim.
 */
export class WakePumpTelemetry {
  private state: WakePumpTelemetrySnapshot['state'] = 'idle';
  private lastProgressAtMs: number | null = null;
  private lastSuccessAtMs: number | null = null;
  private consecutiveFailures = 0;
  private cycleFailed = false;
  private readonly counters: Record<'cycles' | 'claimed' | WakePumpOutcome, number> = {
    cycles: 0,
    claimed: 0,
    sent: 0,
    retry: 0,
    dead: 0,
    fenced: 0,
    error: 0,
    cancelled: 0
  };

  beginCycle(): void {
    if (this.state !== 'stopping') this.state = 'running';
    this.cycleFailed = false;
    this.counters.cycles += 1;
    this.markProgress();
  }

  finishCycle(): void {
    if (this.state !== 'stopping') this.state = 'idle';
    if (this.cycleFailed) {
      this.consecutiveFailures += 1;
    } else {
      this.consecutiveFailures = 0;
      this.lastSuccessAtMs = Date.now();
    }
    this.markProgress();
  }

  markStopping(): void {
    this.state = 'stopping';
    this.markProgress();
  }

  markClaimed(): void {
    this.counters.claimed += 1;
    this.markProgress();
  }

  recordOutcome(outcome: WakePumpOutcome): void {
    this.counters[outcome] += 1;
    if (outcome === 'error' || outcome === 'fenced') this.cycleFailed = true;
    this.markProgress();
  }

  markProgress(): void {
    this.lastProgressAtMs = Date.now();
  }

  snapshot(): WakePumpTelemetrySnapshot {
    return {
      state: this.state,
      lastProgressAtMs: this.lastProgressAtMs,
      lastSuccessAtMs: this.lastSuccessAtMs,
      consecutiveFailures: this.consecutiveFailures,
      counters: { ...this.counters }
    };
  }
}
