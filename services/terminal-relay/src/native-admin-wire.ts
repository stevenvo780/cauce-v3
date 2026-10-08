import { NativeAdminOutcomeSchema, type NativeAdminCommand, type NativeAdminOutcome } from '@cauce/protocol';

export class NativeAdminChannel {
  private readonly requests = new Map<string, (value: NativeAdminOutcome) => void>();
  constructor(private readonly send: (value: Record<string, unknown>) => boolean) {}
  request(command: NativeAdminCommand, timeoutMs: number, signal?: AbortSignal): Promise<NativeAdminOutcome> {
    if (this.requests.size >= 4 || this.requests.has(command.request_id) || signal?.aborted) return Promise.resolve({ type: 'error', error: 'unavailable' });
    return new Promise(resolve => {
      const finish = (value: NativeAdminOutcome) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.requests.delete(command.request_id); resolve(value);
      };
      const abort = () => { finish({ type: 'error', error: 'unavailable' }); };
      const timer = setTimeout(abort, timeoutMs); timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.requests.set(command.request_id, finish);
      try { if (!this.send(command)) abort(); } catch { abort(); }
    });
  }
  receive(body: Record<string, unknown>): void {
    if (typeof body.request_id !== 'string') return;
    const parsed = NativeAdminOutcomeSchema.safeParse(body.outcome);
    this.requests.get(body.request_id)?.(Object.keys(body).sort().join(',') === 'outcome,request_id' && parsed.success ? parsed.data : { type: 'error', error: 'unavailable' });
  }
  close(): void {
    for (const callback of this.requests.values()) callback({ type: 'error', error: 'unavailable' });
    this.requests.clear();
  }
}
