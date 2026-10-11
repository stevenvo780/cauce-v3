import { describe, expect, it, vi } from 'vitest';
import { FleetExecutor, type FleetExecution } from './executor.js';
import type { FleetOperation, FleetOperationRequest, FleetStepName, FleetEvidence } from '@cauce/protocol';
import type { FleetOperationClaim } from '@cauce/store';
const request: FleetOperationRequest = { kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'one' },
  expected_revision: 0, idempotency_key: 'stop-one-isolated', parameters: {} };
function fixture() {
  const calls: string[] = [];
  let operation: FleetOperation = { id: '71000000-0000-4000-8000-000000000001', request_sha256: 'a'.repeat(64),
    actor: { tenant_id: 'Steven', alias: 'operator' }, target: request.target, kind: 'stop', status: 'running', version: 1,
    expected_revision: 0, desired_revision: 1, applied_revision: null, steps: [{ name: 'fence', status: 'succeeded' },
      { name: 'stop', status: 'pending' }], error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const claim: FleetOperationClaim = { operation, request, worker_id: 'worker', epoch: 1,
    claim_token: '71000000-0000-4000-8000-000000000002' };
  const repository = {
    claim: async () => claim, renew: async () => true,
    prepare: async () => ({ operation, fenced_targets: [] }),
    execution: async ():Promise<FleetExecution> => ({ operation, request, fenced_targets: [] }),
    startStep: async (_claim: FleetOperationClaim, name: FleetStepName) => { calls.push(`start:${name}`); return operation; },
    completeStep: async (_claim: FleetOperationClaim, name: FleetStepName, _evidence: FleetEvidence) => {
      calls.push(`complete:${name}`); operation = { ...operation, steps: operation.steps.map((step) => step.name === name ? { ...step, status: 'succeeded' } : step) }; return operation;
    },
    awaitAuth: async () => { calls.push('auth'); return operation; },
    fail: async () => { calls.push('fail'); return operation; },
    compensate: async () => { calls.push('compensate'); return operation; },
    settle: async () => { calls.push('settle'); return operation; },
  };
  return { repository, calls, cancel: () => { operation = { ...operation, status: 'cancelling' }; } };
}
describe('fleet step execution', () => {
  it('does not claim work after host shutdown', async () => {
    const { repository } = fixture();
    const abort = new AbortController(); abort.abort();
    let claimed = false;
    repository.claim = async () => { claimed = true; return null as never; };
    const executor = new FleetExecutor(repository, { worker: 'worker', host: 'isolated', signal: abort.signal,
      perform: async () => ({ evidence: {} }) });
    expect(await executor.runOnce()).toBe(false);
    expect(claimed).toBe(false);
  });
  it('aborts an ongoing effect without completing or settling when the host stops', async () => {
    const { repository, calls } = fixture();
    const abort = new AbortController();
    let interrupted = false;
    const executor = new FleetExecutor(repository, { worker: 'worker', host: 'isolated', signal: abort.signal,
      perform: async (_step, _execution, signal) => {
        abort.abort(); interrupted = signal.aborted;
        return { evidence: { stopped_verified: true } };
      } });
    await executor.runOnce();
    expect(interrupted).toBe(true);
    expect(calls).toEqual(['start:stop']);
  });
  it('does not settle completed steps when shutdown happens during a pending execution read', async () => {
    const { repository, calls } = fixture();
    const abort = new AbortController();
    const read = repository.execution;
    let resolveExecution!: (value: FleetExecution) => void;
    let reachedRead!: () => void;
    const reached = new Promise<void>(resolve => { reachedRead = resolve; });
    const pending = new Promise<FleetExecution>(resolve => { resolveExecution = resolve; });
    let reads = 0;
    repository.execution = async () => {
      if (++reads !== 3) return read();
      reachedRead();return pending;
    };
    const executor = new FleetExecutor(repository, { worker: 'worker', host: 'isolated', signal: abort.signal,
      perform: async () => { calls.push('effect');return { evidence: {} }; } });
    const running = executor.runOnce();
    await reached;abort.abort();
    const execution = await read();
    resolveExecution({ ...execution, operation: { ...execution.operation, steps: [] } });
    expect(await running).toBe(true);
    expect(reads).toBe(3);expect(calls).toEqual([]);
  });
  it('waits for an in-flight renewal before returning after shutdown', async () => {
    vi.useFakeTimers();
    try {
      const { repository, calls } = fixture();
      const abort = new AbortController();
      let resolveRenewal!: (value: boolean) => void;
      const renewal = new Promise<boolean>(resolve => { resolveRenewal = resolve; });
      repository.renew = vi.fn(() => renewal);
      let reachedEffect!: () => void;
      const reached = new Promise<void>(resolve => { reachedEffect = resolve; });
      let resolveEffect!: () => void;
      const effect = new Promise<void>(resolve => { resolveEffect = resolve; });
      const executor = new FleetExecutor(repository, { worker: 'worker', host: 'isolated', leaseMs: 3000, signal: abort.signal,
        perform: async () => { reachedEffect();await effect;return { evidence: { stopped_verified: true } }; } });
      let finished = false;
      const running = executor.runOnce().then(value => { finished = true;return value; });
      await reached;await vi.advanceTimersByTimeAsync(1000);
      expect(repository.renew).toHaveBeenCalledTimes(1);
      abort.abort();resolveEffect();await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(false);
      resolveRenewal(false);expect(await running).toBe(true);
      expect(calls).toEqual(['start:stop']);expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('rechecks durable state and completes a checked stop before settling', async () => {
    const { repository, calls } = fixture();
    const executor = new FleetExecutor(repository, { worker: 'worker', host: 'isolated',
      perform: async (step) => { calls.push(`effect:${step}`); return { evidence: { stopped_verified: true } }; } });
    await executor.runOnce();
    expect(calls).toEqual(['start:stop', 'effect:stop', 'complete:stop', 'settle']);
  });
  it('does not admit or compensate after an unchecked external failure', async () => {
    const { repository, calls } = fixture();
    const executor = new FleetExecutor(repository, { worker: 'worker', host: 'isolated',
      perform: async () => { throw new Error('sensitive process output'); } });
    await executor.runOnce();
    expect(calls).toEqual(['start:stop', 'fail']);
  });
  it('logs one redacted line when a step fails', async () => {
    const { repository } = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const executor = new FleetExecutor(repository, { worker: 'worker', host: 'isolated',
        perform: async () => { throw new TypeError('denied password=hunter2 Bearer abc.def'); } });
      await executor.runOnce();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('fleet step failed step=stop error=TypeError: denied password=[redacted] Bearer [redacted]');
    } finally { log.mockRestore(); }
  });
  it('observes cancellation before starting another effect', async () => {
    const { repository, calls, cancel } = fixture(); cancel();
    const executor = new FleetExecutor(repository, { worker: 'worker', host: 'isolated',
      perform: async () => { calls.push('effect'); return { evidence: {} }; } });
    await executor.runOnce();
    expect(calls).toEqual(['compensate']);
  });
});
