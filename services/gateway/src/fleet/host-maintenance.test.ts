import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetOperationRequestSchema, type FleetOperation } from '@cauce/protocol';
import type { FleetOperationClaim } from '@cauce/store';
import { FleetExecutor, type FleetExecution } from './executor.js';
import { HostMaintenance } from './host-maintenance.js';
import type { MaintenanceGuard } from './host-maintenance-guard.js';
import type { FleetHostConfig } from './main.js';
import type { SignedHostChannel } from './signed-source.js';

const beginGuard = vi.hoisted(() => vi.fn());
vi.mock('./host-maintenance-guard.js', async original => ({
  ...await original<typeof import('./host-maintenance-guard.js')>(), beginMaintenanceGuard: beginGuard,
}));
const RELEASE = 'b'.repeat(64);
const OPERATION = '71000000-0000-4000-8000-000000000001';
const CLAIM = '71000000-0000-4000-8000-000000000002';
function fixture() {
  const calls: string[] = [];
  const request = FleetOperationRequestSchema.parse({ kind: 'update',
    target: { resource: 'agent', tenant_id: 'Steven', alias: 'one' }, expected_revision: 0, idempotency_key: 'maintenance-one',
    parameters: { runtime_key: 'physical-one', harness_id: 'codex', primary_room_id: 'office',
      memberships: [{ room_id: 'office', role: 'agent' }], placement: { host_id: 'test-host', mode: 'container',
        container_name: 'cauce-one', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/.cauce/one' } } });
  let operation: FleetOperation = { id: OPERATION, actor: { tenant_id: 'Steven', alias: 'one', actor_subject: `host:test-host:${'a'.repeat(64)}` },
    target: request.target, kind: 'update', status: 'running', version: 1, request_sha256: 'a'.repeat(64), expected_revision: 0,
    desired_revision: null, applied_revision: null, steps: [{ name: 'prepare', status: 'pending' }, { name: 'stop', status: 'pending' }],
    error: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  const claim: FleetOperationClaim = { operation, request, worker_id: 'worker', claim_token: CLAIM, epoch: 1 };
  const finish = vi.fn(async (commit: boolean) => { calls.push(commit ? 'commit' : 'abort'); });
  const guard: MaintenanceGuard = { first: { state: 'ready', operation_id: OPERATION,
    container_id: 'c'.repeat(64), generation: 'd'.repeat(64), guard_id: 'e'.repeat(32) }, finish };
  beginGuard.mockImplementation(async () => { calls.push('hold'); return guard; });
  const channelRequest = vi.fn(async (_method: string, _path: string, packet: { action: string }) => {
    if (packet.action === 'prepare') {
      calls.push('prepare'); operation = { ...operation, desired_revision: 1,
        steps: operation.steps.map(step => step.name === 'prepare' ? { ...step, status: 'succeeded' } : step) };
      return { prepared: true };
    }
    return { operations: [] };
  });
  const config = { host: 'test-host', projectRoot: `/approved/${RELEASE}`, command: {
    python: '/usr/bin/python3', executable: '/approved/executor.py', policyFile: '/approved/policy.json' } } as FleetHostConfig;
  const maintenance = new HostMaintenance({ request: channelRequest } as unknown as SignedHostChannel, config);
  const execution = (): FleetExecution => ({ operation, request, fenced_targets: [], snapshot: { agents: [] },
    maintenance: { release_sha256: RELEASE }, ...(operation.desired_revision === null ? {} : { fleet_scope: {
      operation_id: OPERATION, host_id: 'test-host', scope_sha256: 'f'.repeat(64), prepared_revision: 1,
      worker_id: 'worker', claim_token: CLAIM, claim_epoch: 1 } }) });
  return { maintenance, channelRequest, execution, calls, claim, guard, finish,
    update: (next: Partial<FleetOperation>) => { operation = { ...operation, ...next }; } };
}
beforeEach(() => { beginGuard.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('automatic host maintenance', () => {
  it('holds the restart guard through preparation and commits only in the durable running stop step', async () => {
    const f = fixture();
    const repository = {
      claim: async () => f.claim, renew: async () => true,
      prepare: vi.fn(async () => { throw new Error('duplicate preparation'); }), execution: async () => f.execution(),
      startStep: async () => { f.calls.push('start:stop'); f.update({ steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'running' }] }); return f.execution().operation; },
      completeStep: async () => { f.calls.push('complete:stop'); f.update({ steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'succeeded' }] }); return f.execution().operation; },
      awaitAuth: async () => f.execution().operation, fail: vi.fn(async () => f.execution().operation),
      compensate: async () => f.execution().operation, settle: async () => { f.calls.push('settle'); return f.execution().operation; },
    };
    await new FleetExecutor(repository, { host: 'test-host', worker: 'worker',
      prepare: (execution, claim, signal) => f.maintenance.prepare(execution, claim, signal),
      finish: claim => f.maintenance.finish(claim), perform: async (_step, execution, _signal, claim) => {
        await f.maintenance.stop(execution, claim); f.calls.push('perform:stop'); return { evidence: { stopped_verified: true } };
      } }).runOnce();
    expect(f.calls).toEqual(['hold', 'prepare', 'start:stop', 'commit', 'perform:stop', 'complete:stop', 'settle']);
    expect(repository.prepare).not.toHaveBeenCalled(); expect(repository.fail).not.toHaveBeenCalled();
  });
  it('aborts the retained guard after shutdown before the durable stop effect', async () => {
    const f = fixture(); const abort = new AbortController();
    const repository = {
      claim: async () => f.claim, renew: async () => true, prepare: async () => ({ operation: f.execution().operation, fenced_targets: [] }),
      execution: async () => f.execution(), startStep: async () => { abort.abort(); return f.execution().operation; },
      completeStep: async () => f.execution().operation, awaitAuth: async () => f.execution().operation,
      fail: vi.fn(async () => f.execution().operation), compensate: async () => f.execution().operation, settle: async () => f.execution().operation,
    };
    const perform = vi.fn(async () => ({ evidence: {} }));
    await new FleetExecutor(repository, { host: 'test-host', worker: 'worker', signal: abort.signal,
      prepare: (execution, claim, signal) => f.maintenance.prepare(execution, claim, signal),
      finish: claim => f.maintenance.finish(claim), perform }).runOnce();
    expect(f.calls).toEqual(['hold', 'prepare', 'abort']); expect(perform).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });
  it('rejects stop with an unprepared, pending or foreign claim without committing its guard', async () => {
    const f = fixture(); await f.maintenance.prepare(f.execution(), f.claim, new AbortController().signal);
    await expect(f.maintenance.stop(f.execution(), f.claim)).rejects.toThrow('current durable host claim');
    f.update({ steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'running' }] });
    await expect(f.maintenance.stop(f.execution(), { ...f.claim, claim_token: 'foreign' })).rejects.toThrow('current durable host claim');
    expect(f.finish).not.toHaveBeenCalled(); await f.maintenance.finish(f.claim); expect(f.finish).toHaveBeenCalledWith(false);
  });
  it('defers a busy unprepared runtime and releases its guard without preparing', async () => {
    const f = fixture(); f.guard.first = { state: 'deferred', reason: 'composer_busy' };
    expect(await f.maintenance.prepare(f.execution(), f.claim, new AbortController().signal)).toBe(false);
    expect(f.channelRequest).toHaveBeenCalledWith('POST', '/v3/fleet/hosts/test-host/channel',
      expect.objectContaining({ action: 'defer', reason: 'composer_busy' }), expect.any(AbortSignal));
    expect(f.calls).toEqual(['hold', 'abort']);
  });
  it('does not classify a prepared busy runtime as a harmless deferral', async () => {
    const f = fixture(); f.update({ desired_revision: 1 }); f.guard.first = { state: 'deferred', reason: 'tui_unreadable' };
    await expect(f.maintenance.prepare(f.execution(), f.claim, new AbortController().signal)).rejects.toThrow('restart guard');
    expect(f.channelRequest).not.toHaveBeenCalled(); expect(f.finish).toHaveBeenCalledWith(false);
  });
  it('starts automatically and backs off failed scans before retrying', async () => {
    const f = fixture(); let now = 0; vi.spyOn(Date, 'now').mockImplementation(() => now);
    f.channelRequest.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    const signal = new AbortController().signal;
    expect(await f.maintenance.runOnce(signal)).toBe(false); expect(f.channelRequest).toHaveBeenCalledTimes(1);
    now = 4_999; await f.maintenance.runOnce(signal); expect(f.channelRequest).toHaveBeenCalledTimes(1);
    now = 5_000; await f.maintenance.runOnce(signal); expect(f.channelRequest).toHaveBeenCalledTimes(2);
    now = 14_999; await f.maintenance.runOnce(signal); expect(f.channelRequest).toHaveBeenCalledTimes(2);
    now = 15_000; await f.maintenance.runOnce(signal); expect(f.channelRequest).toHaveBeenCalledTimes(3);
    now = 30_000; await f.maintenance.runOnce(signal); expect(f.channelRequest).toHaveBeenCalledTimes(3);
    f.maintenance.requestScan(); await f.maintenance.runOnce(signal); expect(f.channelRequest).toHaveBeenCalledTimes(4);
  });
});
