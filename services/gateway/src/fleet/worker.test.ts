import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetEvidence, FleetOperation, FleetOperationRequest, FleetStepName } from '@cauce/protocol';
import type { FleetOperationClaim } from '@cauce/store';
import { FleetHostWorker } from './worker.js';
import type { FleetExecution } from './executor.js';

const request: FleetOperationRequest = { kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'one' },
  expected_revision: 0, idempotency_key: 'worker-stop-one', parameters: {} };
function fixture() {
  let operation: FleetOperation = { id: '72000000-0000-4000-8000-000000000001', request_sha256: 'a'.repeat(64),
    actor: { tenant_id: 'Steven', alias: 'operator' }, target: request.target, kind: 'stop', status: 'running', version: 1,
    expected_revision: 0, desired_revision: 1, applied_revision: null, steps: [{ name: 'fence', status: 'succeeded' },
      { name: 'stop', status: 'pending' }], error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const claim: FleetOperationClaim = { operation, request, worker_id: 'worker', epoch: 1,
    claim_token: '72000000-0000-4000-8000-000000000002' };
  const repository = {
    claim: vi.fn(async (): Promise<FleetOperationClaim | null> => claim), renew: vi.fn(async () => true),
    prepare: vi.fn(async () => ({ operation, fenced_targets: [] })),
    execution: vi.fn(async () => ({ operation, request, fenced_targets: [] })),
    startStep: vi.fn(async (_claim: FleetOperationClaim, _name: FleetStepName) => operation),
    completeStep: vi.fn(async (_claim: FleetOperationClaim, name: FleetStepName, _evidence: FleetEvidence) => {
      operation = { ...operation, steps: operation.steps.map((step) => step.name === name ? { ...step, status: 'succeeded' } : step) };
      return operation;
    }),
    awaitAuth: vi.fn(async () => operation), fail: vi.fn(async () => operation),
    compensate: vi.fn(async () => operation), settle: vi.fn(async () => operation),
  };
  return { repository, cancel: () => { operation = { ...operation, status: 'cancelling' }; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); });
describe('fleet host worker lifecycle', () => {
  it('serializes concurrent runOnce calls and waits for the aborted physical effect at shutdown', async () => {
    const { repository } = fixture();
    const started = deferred<AbortSignal>(); const finished = deferred<undefined>();
    const worker = new FleetHostWorker(repository, { worker: 'worker', host: 'isolated',
      perform: async (_step, _execution, signal) => { started.resolve(signal); await finished.promise; return { evidence: { stopped_verified: true } }; } });
    const first = worker.runOnce(); const second = worker.runOnce();
    const signal = await started.promise;
    expect(repository.claim).toHaveBeenCalledTimes(1);
    let closed = false;
    const shutdown = worker.shutdown().then(() => { closed = true; });
    await Promise.resolve();
    expect(signal.aborted).toBe(true); expect(closed).toBe(false);
    finished.resolve(undefined); await shutdown;
    expect(await first).toBe(true); expect(await second).toBe(true);
    expect(repository.completeStep).not.toHaveBeenCalled(); expect(repository.settle).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    expect(await worker.runOnce()).toBe(false); expect(repository.claim).toHaveBeenCalledTimes(1);
  });
  it('aborts the idle poll delay and does not claim after shutdown', async () => {
    vi.useFakeTimers(); const { repository } = fixture(); repository.claim.mockResolvedValue(null);
    const worker = new FleetHostWorker(repository, { worker: 'worker', host: 'isolated', pollMs: 60_000,
      perform: async () => ({ evidence: {} }) });
    const running = worker.start(); await vi.advanceTimersByTimeAsync(0);
    expect(repository.claim).toHaveBeenCalledTimes(1);
    await worker.shutdown(); await running;
    expect(vi.getTimerCount()).toBe(0); expect(repository.claim).toHaveBeenCalledTimes(1);
  });
  it('retries a failed claim after one bounded delay without surfacing private errors', async () => {
    vi.useFakeTimers(); const { repository } = fixture();
    repository.claim.mockRejectedValueOnce(new Error('postgresql://private:credential@private-host')).mockResolvedValue(null);
    const onError = vi.fn();
    const worker = new FleetHostWorker(repository, { worker: 'worker', host: 'isolated', pollMs: 200,
      onError, perform: async () => ({ evidence: {} }) });
    const running = worker.start(); await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(); expect(repository.claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200); expect(repository.claim).toHaveBeenCalledTimes(2);
    await worker.shutdown(); await running;
  });
  it('uses the executor heartbeat to abort a fenced effect without recording its result', async () => {
    vi.useFakeTimers(); const { repository } = fixture(); repository.renew.mockResolvedValue(false);
    const started = deferred<undefined>();
    const worker = new FleetHostWorker(repository, { worker: 'worker', host: 'isolated', leaseMs: 1000,
      perform: async (_step, _execution, signal) => { started.resolve(undefined);
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
        return { evidence: { stopped_verified: true } };
      } });
    const running = worker.runOnce(); await started.promise;
    await vi.advanceTimersByTimeAsync(350); await running;
    expect(repository.renew).toHaveBeenCalledTimes(1);
    expect(repository.completeStep).not.toHaveBeenCalled(); expect(repository.settle).not.toHaveBeenCalled();
    await worker.shutdown(); expect(vi.getTimerCount()).toBe(0);
  });
  it('passes verified dedicated compensation evidence to durable cancellation', async () => {
    const { repository, cancel } = fixture(); cancel();
    const perform = vi.fn(async () => ({ evidence: {} }));
    const compensate = vi.fn(async (_execution: FleetExecution, _signal: AbortSignal) => ({ stopped_verified: true, revocation_verified: true }));
    const worker = new FleetHostWorker(repository, { worker: 'worker', host: 'isolated', perform, compensate });
    await worker.runOnce(); await worker.shutdown();
    expect(perform).not.toHaveBeenCalled(); expect(compensate).toHaveBeenCalledTimes(1);
    expect(repository.compensate).toHaveBeenCalledWith(expect.anything(), { stopped_verified: true, revocation_verified: true });
  });
  it('rejects unbounded polling intervals before claiming', () => {
    const { repository } = fixture();
    expect(() => new FleetHostWorker(repository, { worker: 'worker', host: 'isolated', pollMs: 0,
      perform: async () => ({ evidence: {} }) })).toThrow('poll interval');
    expect(repository.claim).not.toHaveBeenCalled();
  });
});
