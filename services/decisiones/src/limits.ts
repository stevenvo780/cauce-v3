import { DecisionError } from './errors.js';

export interface LimitOptions {
  /** Sustained decisions per minute per alias. */
  readonly perMinute: number;
  /** Decisions an alias may make back to back before the rate applies. */
  readonly burst: number;
  /** Jev input tokens per alias per UTC day; Jev bills input tokens, so this bounds the spend. */
  readonly dailyInputTokens: number;
  /** Decisions waiting on Jev at once, across all aliases. */
  readonly concurrency: number;
  readonly now?: () => number;
}

interface Bucket { tokens: number; updated: number }
interface DailyUsage { day: string; tokens: number }

/**
 * In-memory on purpose: a restart forgets the counters, which is a bounded loss (one burst and one
 * day's cap) and keeps the service free of state to migrate.
 */
export class Limits {
  private readonly buckets = new Map<string, Bucket>();
  private readonly daily = new Map<string, DailyUsage>();
  private inFlight = 0;
  private readonly now: () => number;

  constructor(private readonly options: LimitOptions) {
    this.now = options.now ?? Date.now;
  }

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Charged before prefilters and Jev: a flood of cheap shortcut decisions is bounded too. */
  admit(alias: string): void {
    const now = this.now();
    const bucket = this.buckets.get(alias) ?? { tokens: this.options.burst, updated: now };
    bucket.tokens = Math.min(this.options.burst, bucket.tokens + ((now - bucket.updated) / 60_000) * this.options.perMinute);
    bucket.updated = now;
    this.buckets.set(alias, bucket);
    if (bucket.tokens < 1) {
      const retryAfterMs = Math.ceil(((1 - bucket.tokens) / this.options.perMinute) * 60_000);
      throw new DecisionError('limite_excedido', `demasiadas decisiones de ${alias}: esperá ${String(Math.ceil(retryAfterMs / 1000))} s`, { retryAfterMs });
    }
    bucket.tokens -= 1;
  }

  assertDailyBudget(alias: string): void {
    const usage = this.daily.get(alias);
    if (usage?.day === this.day() && usage.tokens >= this.options.dailyInputTokens) {
      throw new DecisionError('cupo_diario_agotado', `${alias} agotó su cupo diario de Jev; decidí con tu propio razonamiento hasta mañana (UTC)`);
    }
  }

  charge(alias: string, inputTokens: number): void {
    const today = this.day();
    const usage = this.daily.get(alias);
    if (usage?.day !== today) this.daily.set(alias, { day: today, tokens: inputTokens });
    else usage.tokens += inputTokens;
  }

  dailyTokens(alias: string): number {
    const usage = this.daily.get(alias);
    return usage?.day === this.day() ? usage.tokens : 0;
  }

  async withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.options.concurrency) {
      throw new DecisionError('servicio_ocupado', 'el servicio de decisiones está al tope de concurrencia; reintentá en un segundo', { retryAfterMs: 1000 });
    }
    this.inFlight += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
    }
  }
}
