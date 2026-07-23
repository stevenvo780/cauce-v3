import { randomUUID } from 'node:crypto';
import type { OriginRelayAck, OriginRelayEvent, OriginRelayRepository, OriginTransportRegistry } from './types.js';
import { OriginTransportError } from './types.js';

export interface OriginRelayWorkerOptions {
  repository: OriginRelayRepository;
  transports: OriginTransportRegistry;
  workerId?: string;
  leaseMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  baseRetryMs?: number;
  pollMs?: number;
  onResult?: (result: 'sent' | 'retry' | 'dead') => void;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'origin relay failed';
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 1_000);
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

export class OriginRelayWorker {
  private readonly repository: OriginRelayRepository;
  private readonly transports: OriginTransportRegistry;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;
  private readonly pollMs: number;
  private readonly onResult: (result: 'sent' | 'retry' | 'dead') => void;

  constructor(options: OriginRelayWorkerOptions) {
    this.repository = options.repository;
    this.transports = options.transports;
    this.workerId = options.workerId ?? `origin-relay:${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.batchSize = options.batchSize ?? 20;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseRetryMs = options.baseRetryMs ?? 500;
    this.pollMs = options.pollMs ?? 250;
    this.onResult = options.onResult ?? (() => undefined);
    if (this.leaseMs < 1_000 || this.batchSize < 1 || this.maxAttempts < 1 || this.baseRetryMs < 1 || this.pollMs < 1) {
      throw new Error('origin relay worker options are invalid');
    }
  }

  private acknowledgement(event: OriginRelayEvent, values: Omit<OriginRelayAck, 'event_id' | 'attempt' | 'claim_token'>): OriginRelayAck {
    return {
      event_id: event.event_id,
      attempt: event.attempt,
      claim_token: event.claim_token,
      ...values
    };
  }

  private async process(event: OriginRelayEvent): Promise<void> {
    try {
      const transport = this.transports.forAdapter(event.adapter);
      if (!transport) throw new OriginTransportError(`no transport registered for adapter ${event.adapter}`, false);
      await transport.send(event);
      await this.repository.ack(this.acknowledgement(event, { status: 'sent' }));
      this.onResult('sent');
    } catch (error) {
      const retryable = !(error instanceof OriginTransportError) || error.retryable;
      const shouldRetry = retryable && event.attempt < Math.min(this.maxAttempts, event.max_attempts);
      if (shouldRetry) {
        const retryAfter = Math.min(300_000, this.baseRetryMs * 2 ** Math.max(0, event.attempt - 1));
        await this.repository.ack(this.acknowledgement(event, {
          status: 'retry',
          error: errorMessage(error),
          retry_after_ms: retryAfter
        }));
        this.onResult('retry');
      } else {
        await this.repository.ack(this.acknowledgement(event, {
          status: 'dead',
          error: errorMessage(error)
        }));
        this.onResult('dead');
      }
    }
  }

  async runOnce(): Promise<number> {
    // G1: claim per registered adapter instead of a single unscoped claim. An
    // unscoped claim would lease every pending `origin_relay` event — including
    // 'telegram' events owned by the telegram-bridge — and DLQ the ones without a
    // registered transport. Scoping to `transports.adapters()` (i.e. exactly the
    // adapters from CAUCE_RELAY_ADAPTERS) makes that impossible.
    let processed = 0;
    for (const adapter of this.transports.adapters()) {
      const events = await this.repository.claim(this.workerId, this.batchSize, this.leaseMs, adapter);
      for (const event of events) await this.process(event);
      processed += events.length;
    }
    return processed;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const processed = await this.runOnce();
      if (processed === 0) await sleep(this.pollMs, signal);
    }
  }
}
