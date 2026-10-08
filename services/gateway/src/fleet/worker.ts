import { FleetExecutor, type FleetExecutionRepository, type FleetExecutorOptions } from './executor.js';

export interface FleetHostWorkerOptions extends Omit<FleetExecutorOptions, 'signal'> {
  pollMs?: number;
  onError?(): void;
}
export class FleetHostWorker {
  private readonly abort = new AbortController();
  private readonly executor: FleetExecutor;
  private readonly pollMs: number;
  private active: Promise<boolean> | undefined;
  private loop: Promise<void> | undefined;
  constructor(repository: FleetExecutionRepository, private readonly options: FleetHostWorkerOptions) {
    this.pollMs = options.pollMs ?? 1000;
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 25 || this.pollMs > 60_000) throw new Error('Fleet host poll interval is invalid');
    this.executor = new FleetExecutor(repository, { ...options, signal: this.abort.signal });
  }
  runOnce(): Promise<boolean> {
    if (this.abort.signal.aborted) return Promise.resolve(false);
    this.active ??= this.executor.runOnce().finally(() => { this.active = undefined; });
    return this.active;
  }
  start(): Promise<void> { this.loop ??= this.runLoop(); return this.loop; }
  async shutdown(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([this.active, this.loop]);
  }
  private async runLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try { if (await this.runOnce()) continue; }
      catch { this.options.onError?.(); }
      await this.waitForPoll();
    }
  }
  private waitForPoll(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, this.pollMs);
      this.abort.signal.addEventListener('abort', finish, { once: true });
      if (this.abort.signal.aborted) finish();
    });
  }
}
