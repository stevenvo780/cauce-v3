import type { BackoffConfig, Clock, TimerHandle, TimerOptions } from "./types.js";

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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Aborted", { cause: signal.reason });
}

/**
 * Every adapter timer is unref'd unless the caller asks otherwise: a referenced watchdog or
 * renewal timer keeps the adapter process alive after shutdown, still holding its claim.
 * `keepProcessAlive` is for the timer whose expiry IS the work, such as the queue-wait budget.
 * Cancelling a handle more than once is a no-op.
 */
function scheduled(timer: NodeJS.Timeout, options: TimerOptions | undefined): TimerHandle {
  if (options?.keepProcessAlive !== true) timer.unref();
  return { cancel: () => { clearTimeout(timer); } };
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError(signal));
        },
        { once: true },
      );
    }),
  setTimer: (fn, ms, options) => scheduled(setTimeout(fn, ms), options),
  setRepeating: (fn, ms, options) => scheduled(setInterval(fn, ms), options),
  clearTimer: (handle) => { handle.cancel(); },
};
