import type { ObservabilityRetentionPolicy, ObservabilityRetentionResult } from '@cauce/store';

export type DispatcherPhase =
  | 'stale_deliveries'
  | 'expired_jobs'
  | 'chain_sweep'
  | 'claim_jobs'
  | 'retention';

export const DISPATCHER_PHASES: readonly DispatcherPhase[] = [
  'stale_deliveries', 'expired_jobs', 'chain_sweep', 'claim_jobs', 'retention',
];

export const PHASE_BACKOFF_CAP_MS = 300_000;

export interface MessageAttachmentSweepPolicy {
  readonly messageAttachmentsMs: number;
  readonly chainMaxAgeMs: number;
  readonly batch: number;
}

export interface RetentionSweepPolicy extends ObservabilityRetentionPolicy {
  /**
   * Absent means the attachment strip does not run on THIS tick, and that is the normal case: it
   * rewrites multi-MB bodies of the hottest table, so it keeps its own cadence and its own batch
   * instead of riding the ack/audit sweep's clock.
   */
  readonly messageAttachments?: MessageAttachmentSweepPolicy;
}

export interface RetentionSweepStore {
  pruneObservability(policy: ObservabilityRetentionPolicy): Promise<ObservabilityRetentionResult>;
  pruneMessageAttachments(
    policy: MessageAttachmentSweepPolicy,
  ): Promise<{ message_attachments: number }>;
}

export interface RetentionSweepResult extends ObservabilityRetentionResult {
  readonly message_attachments: number;
  readonly total: number;
}

/**
 * Everything the `retention` phase sweeps, in one call and one summary. The attachment strip is a
 * sibling of `pruneObservability` and not one of its rules because it deletes no row: it removes one
 * key from a body that stays load-bearing, so it carries its own window, its own bound and its own
 * guard.
 */
export async function sweepRetention(
  store: RetentionSweepStore,
  policy: RetentionSweepPolicy,
): Promise<RetentionSweepResult> {
  const { messageAttachments, ...observability } = policy;
  const pruned = await store.pruneObservability(observability);
  const stripped = messageAttachments === undefined
    ? { message_attachments: 0 }
    : await store.pruneMessageAttachments(messageAttachments);
  return {
    ...pruned,
    message_attachments: stripped.message_attachments,
    total: pruned.ack_renewals + pruned.acks + pruned.audit_renewals + pruned.audit_events
      + stripped.message_attachments,
  };
}

export type PhaseOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'skipped' }
  | { readonly status: 'failed'; readonly error: unknown };

export interface PhaseGuardOptions {
  /** Backoff base: the tick interval, so a healthy phase is never delayed. */
  baseMs: number;
  now?: () => number;
  onFailure?: (phase: DispatcherPhase, error: unknown) => void;
}

export function phaseBackoffMs(
  consecutiveFailures: number, baseMs: number, capMs = PHASE_BACKOFF_CAP_MS,
): number {
  if (consecutiveFailures < 1) return 0;
  const base = Math.max(1, Math.trunc(baseMs));
  const exponent = Math.min(consecutiveFailures - 1, 40);
  return Math.min(capMs, base * 2 ** exponent);
}

/**
 * Runs one dispatcher phase in isolation: a throwing phase never reaches its siblings and
 * earns an exponential wait, so a poisoned row cannot spin at full tick rate.
 */
export class PhaseGuard {
  private readonly consecutive = new Map<DispatcherPhase, number>();
  private readonly retryAt = new Map<DispatcherPhase, number>();
  private readonly now: () => number;

  constructor(private readonly options: PhaseGuardOptions) {
    this.now = options.now ?? Date.now;
  }

  async run<T>(phase: DispatcherPhase, action: () => Promise<T>): Promise<PhaseOutcome<T>> {
    const blockedUntil = this.retryAt.get(phase);
    if (blockedUntil !== undefined && this.now() < blockedUntil) return { status: 'skipped' };
    try {
      const value = await action();
      this.consecutive.delete(phase);
      this.retryAt.delete(phase);
      return { status: 'ok', value };
    } catch (error) {
      const failures = (this.consecutive.get(phase) ?? 0) + 1;
      this.consecutive.set(phase, failures);
      this.retryAt.set(
        phase, this.now() + phaseBackoffMs(failures, this.options.baseMs),
      );
      this.options.onFailure?.(phase, error);
      return { status: 'failed', error };
    }
  }

  consecutiveFailures(phase: DispatcherPhase): number {
    return this.consecutive.get(phase) ?? 0;
  }
}
