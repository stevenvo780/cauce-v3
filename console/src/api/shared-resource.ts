import type { RecargaResultado, Resource } from './use-resource';

/**
 * One read that several views share instead of each fetching on its own clock.
 *
 * The first subscriber starts the read and the poller; the last one to leave stops the poller but
 * keeps the snapshot, so reopening a view inside the period reuses it instead of fetching again.
 * `reload()` keeps the `useResource` contract: it resolves with the fetch that starts after the call.
 */
export class SharedResource<T> {
  private snapshot: Resource<T>;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private waiting: ((result: RecargaResultado<T>) => void)[] = [];
  private settledAt = 0;

  constructor(private readonly loader: () => Promise<T>, private readonly periodMs: number) {
    this.snapshot = { loading: true, reload: this.reload };
  }

  readonly getSnapshot = (): Resource<T> => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      const stale = this.snapshot.data === undefined || this.snapshot.error !== undefined
        || Date.now() - this.settledAt >= this.periodMs;
      if (stale && !this.inFlight) void this.reload();
      this.timer = setInterval(() => { if (!this.inFlight) void this.reload(); }, this.periodMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) { clearInterval(this.timer); this.timer = undefined; }
    };
  };

  readonly reload = (): Promise<RecargaResultado<T>> => {
    const answer = new Promise<RecargaResultado<T>>((resolve) => { this.waiting.push(resolve); });
    if (!this.inFlight) this.run();
    return answer;
  };

  private run(): void {
    this.inFlight = true;
    const answering = this.waiting;
    this.waiting = [];
    // Without prior data the error stays visible during the retry, as `useResource` does, to avoid flicker.
    this.publish({ loading: true, error: this.snapshot.data === undefined ? this.snapshot.error : undefined });
    void Promise.resolve().then(this.loader).then(
      (data): RecargaResultado<T> => { this.publish({ data, error: undefined, loading: false }); return { data }; },
      (cause: unknown): RecargaResultado<T> => {
        const error = cause instanceof Error ? cause : new Error('Error desconocido');
        this.publish({ error, loading: false });
        return { error };
      },
    ).then((result) => {
      this.settledAt = Date.now();
      this.inFlight = false;
      for (const resolve of answering) resolve(result);
      if (this.waiting.length) this.run();
    });
  }

  private publish(change: Partial<Resource<T>>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
}
