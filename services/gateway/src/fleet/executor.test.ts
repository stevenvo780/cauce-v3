import { describe, expect, it } from 'vitest';
import { FleetExecutor } from './executor.js';
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
    execution: async () => ({ operation, request, fenced_targets: [] }),
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
  it('observes cancellation before starting another effect', async () => {
    const { repository, calls, cancel } = fixture(); cancel();
    const executor = new FleetExecutor(repository, { worker: 'worker', host: 'isolated',
      perform: async () => { calls.push('effect'); return { evidence: {} }; } });
    await executor.runOnce();
    expect(calls).toEqual(['compensate']);
  });
});
