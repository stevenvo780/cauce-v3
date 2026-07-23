import { randomUUID } from 'node:crypto';
import type { ShadowInboxRepository, ShadowMetric } from './types.js';
import type { ShadowRouter } from './router.js';

export interface ShadowRouterWorkerOptions {
  repository: ShadowInboxRepository;
  router: ShadowRouter;
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  baseRetryMs?: number;
  onMetric?: (metric: ShadowMetric) => void;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'shadow routing failed';
  return message.replace(/[\r\n\t]/g, ' ').replace(/[0-9]{5,}/g, '<id>').slice(0, 500);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class ShadowRouterWorker {
  private readonly repository: ShadowInboxRepository;
  private readonly router: ShadowRouter;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly baseRetryMs: number;
  private readonly onMetric: (metric: ShadowMetric) => void;

  constructor(options: ShadowRouterWorkerOptions) {
    this.repository = options.repository;
    this.router = options.router;
    this.workerId = options.workerId ?? `shadow-router:${randomUUID()}`;
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.baseRetryMs = options.baseRetryMs ?? 500;
    this.onMetric = options.onMetric ?? (() => undefined);
  }

  async runOnce(): Promise<number> {
    const events = await this.repository.claim(this.workerId, this.batchSize, this.leaseMs);
    for (const event of events) {
      try {
        if (event.mode !== this.router.mode) throw new Error('persisted shadow mode does not match runtime mode');
        await this.router.route(event.envelope);
        await this.repository.completeInbox(event);
      } catch (error) {
        const delay = Math.min(300_000, this.baseRetryMs * 2 ** Math.max(0, event.attempt - 1));
        await this.repository.retryInbox(event, delay, safeError(error));
        this.onMetric('failed');
      }
    }
    return events.length;
  }

  async run(signal: AbortSignal, idleMs = 250): Promise<void> {
    while (!signal.aborted) {
      try {
        const count = await this.runOnce();
        if (count === 0) await sleep(idleMs, signal);
      } catch {
        if (!signal.aborted) await sleep(1_000, signal);
      }
    }
  }
}
