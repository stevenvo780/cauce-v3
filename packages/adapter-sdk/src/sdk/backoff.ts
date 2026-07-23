import type { BackoffConfig, Clock } from "./types.js";

export const DEFAULT_BACKOFF: BackoffConfig = {
  initialMs: 250,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

export class ExponentialBackoff {
  private attempt = 0;

  constructor(
    private readonly config: BackoffConfig = DEFAULT_BACKOFF,
    private readonly random: () => number = Math.random,
  ) {
    if (config.initialMs < 0 || config.maxMs < config.initialMs) {
      throw new RangeError("Invalid reconnect delay range");
    }
    if (config.factor < 1 || config.jitter < 0 || config.jitter > 1) {
      throw new RangeError("Invalid reconnect factor or jitter");
    }
  }

  nextDelay(): number {
    const base = Math.min(
      this.config.maxMs,
      this.config.initialMs * this.config.factor ** this.attempt++,
    );
    const spread = base * this.config.jitter;
    const sampled = base - spread + this.random() * spread * 2;
    return Math.max(0, Math.round(sampled));
  }

  reset(): void {
    this.attempt = 0;
  }
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("Aborted"));
        },
        { once: true },
      );
    }),
};
