import { DecisionError } from './errors.js';

export interface LimitOptions {
  /** Sustained decisions per minute per alias. */
  readonly perMinute: number;
  /** Decisions an alias may make back to back before the rate applies. */
  readonly burst: number;
  /** Jev input tokens per alias per UTC day; Jev bills input tokens, so this bounds the spend. */
  readonly dailyInputTokens: number;
  /** Jev input tokens per UTC day across every alias. */
  readonly dailyInputTokensTotal: number;
  /** Decisions waiting on Jev at once, across all aliases. */
  readonly concurrency: number;
  /** Decisions waiting on Jev at once for a single alias. */
  readonly concurrencyPerAlias: number;
  readonly now?: () => number;
}

interface Bucket { tokens: number; updated: number }
interface DailyUsage { day: string; used: number; reserved: number }

/** Tokens held for one decision in flight; `settle` swaps them for what it actually cost. */
export interface Reservation {
  readonly alias: string;
  readonly tokens: number;
  settled: boolean;
}

/**
 * In-memory on purpose: a restart forgets the counters, which is a bounded loss (one burst and one
 * day's cap) and keeps the service free of state to migrate.
 */
export class Limits {
  private readonly buckets = new Map<string, Bucket>();
  private readonly daily = new Map<string, DailyUsage>();
  private total: DailyUsage = { day: '', used: 0, reserved: 0 };
  private readonly inFlightByAlias = new Map<string, number>();
  private inFlight = 0;
  private readonly now: () => number;

  constructor(private readonly options: LimitOptions) {
    this.now = options.now ?? Date.now;
  }

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /* A new UTC day forgets what was spent but keeps what is still in flight. */
  private current(usage: DailyUsage | undefined): DailyUsage {
    const today = this.day();
    return usage?.day === today ? usage : { day: today, used: 0, reserved: usage?.reserved ?? 0 };
  }

  private usage(alias: string): DailyUsage {
    const usage = this.current(this.daily.get(alias));
    this.daily.set(alias, usage);
    return usage;
  }

  private fleet(): DailyUsage {
    this.total = this.current(this.total);
    return this.total;
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

  /**
   * Holds the worst case of one decision before it is sent, so concurrent decisions see each other
   * and the daily caps are a ceiling rather than a number checked against a stale counter.
   */
  reserve(alias: string, tokens: number): Reservation {
    const own = this.usage(alias);
    const fleet = this.fleet();
    if (own.used + own.reserved + tokens > this.options.dailyInputTokens) {
      throw new DecisionError('cupo_diario_agotado', `${alias} agotó su cupo diario de Jev; decidí con tu propio razonamiento hasta mañana (UTC)`);
    }
    if (fleet.used + fleet.reserved + tokens > this.options.dailyInputTokensTotal) {
      throw new DecisionError('cupo_diario_agotado', 'la flota agotó el cupo diario de Jev; decidí con tu propio razonamiento hasta mañana (UTC)');
    }
    own.reserved += tokens;
    fleet.reserved += tokens;
    return { alias, tokens, settled: false };
  }

  settle(reservation: Reservation, spentTokens: number): void {
    if (reservation.settled) return;
    reservation.settled = true;
    for (const usage of [this.usage(reservation.alias), this.fleet()]) {
      usage.reserved = Math.max(0, usage.reserved - reservation.tokens);
      usage.used += spentTokens;
    }
  }

  dailyTokens(alias: string): number {
    return this.usage(alias).used;
  }

  fleetDailyTokens(): number {
    return this.fleet().used;
  }

  async withSlot<T>(alias: string, work: () => Promise<T>): Promise<T> {
    const own = this.inFlightByAlias.get(alias) ?? 0;
    if (this.inFlight >= this.options.concurrency) {
      throw new DecisionError('servicio_ocupado', 'el servicio de decisiones está al tope de concurrencia; reintentá en un segundo', { retryAfterMs: 1000 });
    }
    if (own >= this.options.concurrencyPerAlias) {
      throw new DecisionError('servicio_ocupado', `${alias} ya tiene ${String(own)} decisiones esperando a Jev; reintentá en un segundo`, { retryAfterMs: 1000 });
    }
    this.inFlight += 1;
    this.inFlightByAlias.set(alias, own + 1);
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      const left = (this.inFlightByAlias.get(alias) ?? 1) - 1;
      if (left > 0) this.inFlightByAlias.set(alias, left);
      else this.inFlightByAlias.delete(alias);
    }
  }
}
