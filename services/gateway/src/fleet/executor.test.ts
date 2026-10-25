import { describe, expect, it, vi } from 'vitest';
import { FleetExecutor, type FleetExecution } from './executor.js';
import type { FleetOperation, FleetOperationRequest, FleetStepName, FleetEvidence, FleetError } from '@cauce/protocol';
import { FleetOperationRequestSchema } from '@cauce/protocol';
import { FleetExecutionFailure } from './recovery-host-command.js';
import { FleetOperationError, type FleetOperationClaim } from '@cauce/store';
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
    fail: async (_claim: FleetOperationClaim, _error: FleetError) => { calls.push('fail'); return operation; },
    compensate: async () => { calls.push('compensate'); return operation; },
    settle: async (_claim: FleetOperationClaim, _retirement?: FleetEvidence) => { calls.push('settle'); return operation; },
  };
  return { repository, calls, cancel: () => { operation = { ...operation, status: 'cancelling' }; } };
}
describe('fleet step execution', () => {
  it('commits admission before retirement and settles success only after its receipt', async () => {
    const { repository, calls } = fixture();
    const read = repository.execution;
    let committed = false;
    repository.execution = async () => {
      const execution = await read();
      return { ...execution, operation: { ...execution.operation, steps: [] },
        ...(committed ? { snapshot: { replacement_commit: { decision: 'configuration_committed' } } } : {}) };
    };
    repository.prepare = vi.fn(repository.prepare);
    repository.settle = vi.fn(async (_claim: FleetOperationClaim, proof?: FleetEvidence): Promise<FleetOperation> => {
      calls.push(proof ? 'succeeded' : 'configuration_committed'); committed = true;
      return { ...(await read()).operation, status: proof ? 'succeeded' : 'running' };
    });
    const retirement: FleetEvidence = { stopped_verified: true };
    const retire = vi.fn(async () => { calls.push('retire'); return retirement; });
    const perform = vi.fn(async () => ({ evidence: {} }));
    await new FleetExecutor(repository, { worker: 'worker', host: 'isolated', perform, retire }).runOnce();
    expect(calls).toEqual(['configuration_committed', 'retire', 'succeeded']);
    expect(repository.prepare).toHaveBeenCalledOnce(); expect(perform).not.toHaveBeenCalled();
    expect(repository.settle).toHaveBeenLastCalledWith(expect.anything(), retirement);
  });
  it('reclaims an already committed replacement without preparing or repeating operation effects', async () => {
    const { repository, calls } = fixture(); const read = repository.execution;
    repository.execution = async () => ({ ...await read(), snapshot: { replacement_commit: { decision: 'configuration_committed' } } });
    repository.prepare = vi.fn(repository.prepare);
    const perform = vi.fn(async () => ({ evidence: {} }));
    const retire = vi.fn(async () => { calls.push('retire'); return { stopped_verified: true }; });
    const prepare = vi.fn(async () => true); const finish = vi.fn(async () => undefined);
    await new FleetExecutor(repository, { worker: 'worker', host: 'isolated', perform, retire, prepare, finish }).runOnce();
    expect(calls).toEqual(['retire', 'settle']); expect(repository.prepare).not.toHaveBeenCalled();
    expect(perform).not.toHaveBeenCalled(); expect(retire).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledOnce();
  });
  it('records a retirement failure without settling or compensating the committed replacement', async () => {
    const { repository, calls } = fixture(); const read = repository.execution;
    repository.execution = async () => ({ ...await read(), snapshot: { replacement_commit: { decision: 'configuration_committed' } } });
    await new FleetExecutor(repository, { worker: 'worker', host: 'isolated', perform: async () => ({ evidence: {} }),
      retire: async () => { throw new Error('retirement unavailable'); } }).runOnce();
    expect(calls).toEqual(['fail']);
  });
  it('does not commit a retirement receipt after losing the worker signal', async () => {
    const { repository, calls } = fixture(); const read = repository.execution; const abort = new AbortController();
    repository.execution = async () => ({ ...await read(), snapshot: { replacement_commit: { decision: 'configuration_committed' } } });
    await new FleetExecutor(repository, { worker: 'worker', host: 'isolated', signal: abort.signal,
      perform: async () => ({ evidence: {} }), retire: async () => { abort.abort(); return { stopped_verified: true }; } }).runOnce();
    expect(calls).toEqual([]);
  });
  it('records the typed revision conflict without dispatching retirement when the source refuses its changed seal', async () => {
    const { repository } = fixture(); const operation = (await repository.execution()).operation;
    repository.execution = async () => { throw new FleetOperationError('conflict', 'sealed configuration changed'); };
    repository.fail = vi.fn(async () => operation);
    const perform = vi.fn(async () => ({ evidence: {} })); const retire = vi.fn(async () => ({}));
    await new FleetExecutor(repository, { worker: 'worker', host: 'isolated', perform, retire }).runOnce();
    expect(perform).not.toHaveBeenCalled(); expect(retire).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), { code: 'REVISION_CONFLICT', retryable: true });
  });
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
  it.each(['create', 'update', 'start', 'stop', 'retire', 'restore', 'purge', 'recover'] as const)('persists a typed failure for %s without requiring a recovery operation', async kind => {
    const f = fixture(); const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = await f.repository.claim();
    const parameters = kind === 'recover' ? { action: 'probe' } : kind === 'create' || kind === 'update' ? {
      runtime_key: 'physical-one', harness_id: 'codex', primary_room_id: 'office', memberships: [{ room_id: 'office', role: 'agent' }],
      placement: { host_id: 'old-host', mode: 'container', container_name: 'cauce-one', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/.cauce/one' } } : {};
    const current = FleetOperationRequestSchema.parse({ ...request, kind, parameters });
    const fail = vi.fn(async (_claim: FleetOperationClaim, _error: FleetError) => original.operation);
    const repository = { ...f.repository, fail, claim: async () => ({ ...original, request: current }),
      execution: async () => ({ ...await f.repository.execution(), request: current }) };
    try {
      await new FleetExecutor(repository, { host: 'isolated', worker: 'worker',
        perform: async () => { throw new FleetExecutionFailure('runtime_identity_mismatch'); } }).runOnce();
      expect(fail.mock.calls[0]?.[1]).toEqual({ code: 'STEP_FAILED', step: 'stop', retryable: true, reason: 'runtime_identity_mismatch' });
      expect(log.mock.calls.flat().join(' ')).not.toContain('PRIVATE');
    } finally { log.mockRestore(); }
  });
  it('persists a typed compensation failure without releasing its fence', async () => {
    const f = fixture(); f.cancel(); const original = await f.repository.claim();
    const fail = vi.fn(async (_claim: FleetOperationClaim, _error: FleetError) => original.operation);
    const compensate = vi.fn(f.repository.compensate); const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await new FleetExecutor({ ...f.repository, fail, compensate }, { host: 'isolated', worker: 'worker',
        perform: async () => ({ evidence: {} }), compensate: async () => { throw new FleetExecutionFailure('runtime_stop_unverified'); } }).runOnce();
      expect(fail.mock.calls[0]?.[1]).toEqual({ code: 'STEP_FAILED', retryable: true, reason: 'runtime_stop_unverified' });
      expect(compensate).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
