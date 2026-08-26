import { randomUUID } from 'node:crypto';
import { ShadowRouteExecutionError } from './errors.js';
import type { ShadowInboxLease, ShadowInboxRepository } from './types.js';
import type { ShadowRouter } from './router.js';
import type { ShadowRouterProgress } from './progress.js';

export interface ShadowRouterWorkerOptions {
  repository: ShadowInboxRepository;
  router: ShadowRouter;
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  baseRetryMs?: number;
  progress?: ShadowRouterProgress;
  onLoopError?: (error: string) => void;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'shadow routing failed';
  return message.replace(/[\r\n\t]/g, ' ').replace(/[0-9]{5,}/g, '<id>').slice(0, 500);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    const aborted = (): void => {
      clearTimeout(timer);
      done();
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function settlementSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  // The process-wide signal is already aborted when shutdown wins a route. Lease settlement still
  // needs one short, independently bounded transaction so a pre-target event is returned without
  // consuming an attempt and an ambiguous post-target event is made retryable.
  return signal?.aborted ? AbortSignal.timeout(1_000) : signal;
}

export class ShadowRouterWorker {
  private readonly repository: ShadowInboxRepository;
  private readonly router: ShadowRouter;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly baseRetryMs: number;
  private readonly progress: ShadowRouterProgress | undefined;
  private readonly onLoopError: (error: string) => void;

  constructor(options: ShadowRouterWorkerOptions) {
    this.repository = options.repository;
    this.router = options.router;
    this.workerId = options.workerId ?? `shadow-router:${randomUUID()}`;
    // Claims start a lease clock immediately, while routing is deliberately ordered.  Claiming a
    // batch of 20 and then spending up to 15 s on each target made the later 18 leases expire
    // before they were even attempted.  One-at-a-time still drains continuously without idle
    // sleeps and preserves source order.
    this.batchSize = options.batchSize ?? 1;
    if (this.batchSize !== 1) throw new Error('shadow router batchSize must be 1 for ordered leased routing');
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 20_000) {
      throw new Error('shadow router leaseMs must be an integer of at least 20000');
    }
    this.baseRetryMs = options.baseRetryMs ?? 500;
    this.progress = options.progress;
    this.onLoopError = options.onLoopError ?? (() => undefined);
  }

  private async releaseUnstarted(
    events: readonly ShadowInboxLease[],
    signal?: AbortSignal,
  ): Promise<number> {
    const cleanupSignal = settlementSignal(signal);
    const settled = await Promise.allSettled(events.map(async (event) => {
      try {
        await this.repository.releaseUnstartedInbox(
          event,
          'shadow router stopped before target invocation',
          cleanupSignal,
        );
      } catch (error) {
        this.repository.abandonLocalInboxClaim(event);
        throw error;
      }
    }));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    return events.length;
  }

  async runOnce(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) {
      this.progress?.stopping();
      return 0;
    }
    this.progress?.cycleStarted();
    try {
      const events = await this.repository.claim(this.workerId, this.batchSize, this.leaseMs, signal);
      let routed = 0;
      let failed = 0;
      let releasedDuringRouting = 0;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        if (signal?.aborted) {
          const released = await this.releaseUnstarted(events.slice(index), signal);
          this.progress?.cycleAborted({ claimed: events.length, routed, failed, released });
          return events.length;
        }
        let dispatchArmed = false;
        let targetInvoked = false;
        let routeCompleted = false;
        try {
          if (event.mode !== this.router.mode) throw new Error('persisted shadow mode does not match runtime mode');
          const result = await this.router.route(event.envelope, signal, {
            beforeTarget: async () => {
              await this.repository.markTargetStarted(event, signal);
              dispatchArmed = true;
            },
          });
          targetInvoked = result.target_invoked;
          if (targetInvoked !== dispatchArmed) {
            throw new Error('shadow route target boundary disagrees with its durable inbox phase');
          }
          routeCompleted = true;
          await this.repository.completeInbox(event, signal);
          routed += 1;
        } catch (error) {
          if (error instanceof ShadowRouteExecutionError) targetInvoked = error.targetInvoked;
          const cleanupSignal = settlementSignal(signal);
          try {
            if (routeCompleted && targetInvoked) {
              // The target succeeded and its mapping is terminal. Retrying the target attempt here
              // can manufacture a final dead-letter after a valid delivery. Retry only the
              // idempotent inbox completion (also resolves a lost COMMIT acknowledgement); if the
              // DB remains unavailable, leave the lease for mapping-aware expiry reconciliation.
              await this.repository.completeInbox(event, cleanupSignal);
              routed += 1;
            } else if (dispatchArmed && targetInvoked) {
              const delay = Math.min(300_000, this.baseRetryMs * 2 ** Math.max(0, event.attempt - 1));
              const outcome = await this.repository.retryInbox(event, delay, safeError(error), cleanupSignal);
              if (outcome === 'done') routed += 1;
              else failed += 1;
            } else {
              await this.repository.releaseUnstartedInbox(event, safeError(error), cleanupSignal);
              releasedDuringRouting += 1;
            }
          } catch (settlementError) {
            // The worker no longer owns active work for this token. Removing only the boot-local
            // ownership marker makes health report the still-durable row as orphaned until its
            // lease expires and the mapping-aware reaper settles it.
            this.repository.abandonLocalInboxClaim(event);
            throw settlementError;
          }
        }
        this.progress?.eventSettled();
        if (signal?.aborted) {
          const released = await this.releaseUnstarted(events.slice(index + 1), signal);
          this.progress?.cycleAborted({
            claimed: events.length,
            routed,
            failed,
            released: released + releasedDuringRouting,
          });
          return events.length;
        }
      }
      this.progress?.cycleCompleted({
        claimed: events.length,
        routed,
        failed,
        released: releasedDuringRouting,
      });
      return events.length;
    } catch (error) {
      this.progress?.cycleFailed();
      throw error;
    }
  }

  async run(signal: AbortSignal, idleMs = 250): Promise<void> {
    while (!signal.aborted) {
      try {
        const count = await this.runOnce(signal);
        if (count === 0) await sleep(idleMs, signal);
      } catch (error) {
        this.onLoopError(safeError(error));
        if (!signal.aborted) {
          await sleep(1_000, signal);
        }
      }
    }
    this.progress?.stopping();
  }
}
