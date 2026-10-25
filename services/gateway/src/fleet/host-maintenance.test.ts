import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetOperationRequestSchema, sha256Hex, type FleetOperation } from '@cauce/protocol';
import type { FleetOperationClaim } from '@cauce/store';
import { FleetExecutor, type FleetExecution } from './executor.js';
import { HostMaintenance } from './host-maintenance.js';
import type { MaintenanceGuard } from './host-maintenance-guard.js';
import type { FleetHostConfig } from './main.js';
import type { SignedHostChannel } from './signed-source.js';

const beginGuard = vi.hoisted(() => vi.fn());
const proveResume = vi.hoisted(() => vi.fn());
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock('./host-maintenance-guard.js', async original => ({
  ...await original<typeof import('./host-maintenance-guard.js')>(), beginMaintenanceGuard: beginGuard,
  proveMaintenanceResume: proveResume,
}));
vi.mock('./host-command.js', async original => ({
  ...await original<typeof import('./host-command.js')>(), performHostMaintenanceCheckpoint: checkpoint,
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
  proveResume.mockImplementation(async () => { calls.push('proof'); return 'f'.repeat(64); });
  const previous = { tenant_id: 'Steven', alias: 'one', company_id: 'company', harness_id: 'codex', display_name: null,
    enabled: true, runtime_key: 'physical-one', primary_room_id: 'office', host_id: 'test-host', runtime_mode: 'container',
    container_name: 'cauce-one', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/.cauce/one',
    systemd_user: 'dev', primary_account_id: null, model_id: null, reasoning_effort: null, extensions: [], lifecycle_state: 'ready',
    created_at: '2026-01-01T00:00:00Z', retired_at: null, purged_at: null };
  const body = { version: 1, operation_id: OPERATION, company_id: 'company', target: request.target,
    previous_agents: [previous], previous_memberships: [] };
  const snapshot_canonical = JSON.stringify(body);
  const compensation_snapshot = { ...body, snapshot_canonical, snapshot_sha256: sha256Hex(snapshot_canonical) };
  const receipt = { snapshot_sha256: compensation_snapshot.snapshot_sha256, original_container_id: 'c'.repeat(64),
    checkpoint_sha256: 'a'.repeat(64), generation: 'd'.repeat(64) };
  checkpoint.mockImplementation(async () => { calls.push('checkpoint'); return receipt; });
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
  const execution = (): FleetExecution => ({ operation, request, fenced_targets: [], previous_agents: [previous], snapshot: { agents: [], compensation_snapshot },
    maintenance: { release_sha256: RELEASE }, ...(operation.desired_revision === null ? {} : { fleet_scope: {
      operation_id: OPERATION, host_id: 'test-host', scope_sha256: 'f'.repeat(64), prepared_revision: 1,
      worker_id: 'worker', claim_token: CLAIM, claim_epoch: 1 } }) });
  return { maintenance, channelRequest, execution, calls, claim, guard, finish, receipt,
    update: (next: Partial<FleetOperation>) => { operation = { ...operation, ...next }; } };
}
function repositoryFor(f: ReturnType<typeof fixture>) {
  return {
    claim: async () => f.claim, renew: async () => true,
    prepare: vi.fn(async () => { throw new Error('duplicate preparation'); }), execution: async () => f.execution(),
    startStep: async () => { f.calls.push('start:stop'); f.update({ steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'running' }] }); return f.execution().operation; },
    completeStep: async () => { f.calls.push('complete:stop'); f.update({ steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'succeeded' }] }); return f.execution().operation; },
    awaitAuth: async () => f.execution().operation, fail: vi.fn(async () => f.execution().operation),
    compensate: async () => f.execution().operation, settle: async () => { f.calls.push('settle'); return f.execution().operation; },
  };
}
beforeEach(() => { beginGuard.mockReset(); proveResume.mockReset(); checkpoint.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('automatic host maintenance', () => {
  it('holds the restart guard through preparation and commits only in the durable running stop step', async () => {
    const f = fixture();
    const repository = repositoryFor(f);
    await new FleetExecutor(repository, { host: 'test-host', worker: 'worker',
      prepare: (execution, claim, signal) => f.maintenance.prepare(execution, claim, signal),
      finish: claim => f.maintenance.finish(claim), perform: async (_step, execution, signal, claim) => {
        await f.maintenance.stop(execution, claim, signal); f.calls.push('perform:stop'); return { evidence: { stopped_verified: true } };
      } }).runOnce();
    expect(f.calls).toEqual(['hold', 'proof', 'prepare', 'start:stop', 'checkpoint', 'commit', 'perform:stop', 'complete:stop', 'settle']);
    expect(f.channelRequest).toHaveBeenCalledWith('POST', '/v3/fleet/hosts/test-host/channel',
      expect.objectContaining({ action: 'prepare', resume_sha256: 'f'.repeat(64) }), expect.any(AbortSignal));
    expect(repository.prepare).not.toHaveBeenCalled(); expect(repository.fail).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(AbortSignal), false);
  });
  it('aborts the retained guard through executor cleanup when the signed checkpoint fails', async () => {
    const f = fixture(); const repository = repositoryFor(f);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    checkpoint.mockImplementationOnce(async () => { f.calls.push('checkpoint'); throw new Error('checkpoint rejected'); });
    await new FleetExecutor(repository, { host: 'test-host', worker: 'worker',
      prepare: (execution, claim, signal) => f.maintenance.prepare(execution, claim, signal),
      finish: claim => f.maintenance.finish(claim), perform: async (_step, execution, signal, claim) => {
        await f.maintenance.stop(execution, claim, signal); f.calls.push('perform:stop'); return { evidence: { stopped_verified: true } };
      } }).runOnce();
    expect(f.calls).toEqual(['hold', 'proof', 'prepare', 'start:stop', 'checkpoint', 'abort']);
    expect(repository.fail).toHaveBeenCalledOnce(); expect(f.finish).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(['snapshot_sha256', 'original_container_id', 'generation'] as const)('rejects a checkpoint with a different %s before physical commit', async field => {
    const f = fixture(); const signal = new AbortController().signal;
    await f.maintenance.prepare(f.execution(), f.claim, signal);
    f.update({ steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'running' }] });
    checkpoint.mockResolvedValueOnce({ ...f.receipt, [field]: '9'.repeat(64) });
    await expect(f.maintenance.stop(f.execution(), f.claim, signal)).rejects.toThrow('checkpoint differs');
    expect(f.finish).not.toHaveBeenCalled(); await f.maintenance.finish(f.claim);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(false);
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
    expect(f.calls).toEqual(['hold', 'proof', 'prepare', 'abort']); expect(perform).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });
  it('rejects stop with an unprepared, pending or foreign claim without committing its guard', async () => {
    const f = fixture(); await f.maintenance.prepare(f.execution(), f.claim, new AbortController().signal);
    await expect(f.maintenance.stop(f.execution(), f.claim, new AbortController().signal)).rejects.toThrow('current durable host claim');
    f.update({ steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'running' }] });
    await expect(f.maintenance.stop(f.execution(), { ...f.claim, claim_token: 'foreign' }, new AbortController().signal)).rejects.toThrow('current durable host claim');
    expect(checkpoint).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled(); await f.maintenance.finish(f.claim); expect(f.finish).toHaveBeenCalledWith(false);
  });
  it('defers a busy unprepared runtime and releases its guard without preparing', async () => {
    const f = fixture(); f.guard.first = { state: 'deferred', reason: 'composer_busy' };
    expect(await f.maintenance.prepare(f.execution(), f.claim, new AbortController().signal)).toBe(false);
    expect(f.channelRequest).toHaveBeenCalledWith('POST', '/v3/fleet/hosts/test-host/channel',
      expect.objectContaining({ action: 'defer', reason: 'composer_busy' }), expect.any(AbortSignal));
    expect(f.calls).toEqual(['hold', 'abort']);
  });
  it('defers a runtime without an exact resume proof before preparation and restores the retained input guard', async () => {
    const f = fixture(); proveResume.mockRejectedValueOnce(new Error('missing native pointer'));
    expect(await f.maintenance.prepare(f.execution(), f.claim, new AbortController().signal)).toBe(false);
    expect(f.channelRequest).toHaveBeenCalledWith('POST', '/v3/fleet/hosts/test-host/channel',
      expect.objectContaining({ action: 'defer', reason: 'preflight_unavailable' }), expect.any(AbortSignal));
    expect(f.calls).toEqual(['hold', 'abort']); expect(f.execution().operation.desired_revision).toBeNull();
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('never prepares an unobserved stopped runtime as if a native conversation had been protected', async () => {
    const f = fixture(); f.guard.first = { state: 'stopped' };
    expect(await f.maintenance.prepare(f.execution(), f.claim, new AbortController().signal)).toBe(false);
    expect(proveResume).not.toHaveBeenCalled(); expect(f.calls).toEqual(['hold', 'abort']);
    expect(f.execution().operation.desired_revision).toBeNull();
  });
  it('replays the exact running stop after a crash between its physical effect and durable receipt', async () => {
    const f = fixture(); f.guard.first = { state: 'stopped' };
    f.update({ desired_revision: 1, steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'running' }] });
    const repository = {
      claim: async () => f.claim, renew: async () => true, execution: async () => f.execution(),
      prepare: vi.fn(async () => ({ operation: f.execution().operation, fenced_targets: [] })),
      startStep: async () => f.execution().operation,
      completeStep: async () => { f.update({ steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'succeeded' }] }); return f.execution().operation; },
      awaitAuth: async () => f.execution().operation, fail: vi.fn(async () => f.execution().operation),
      compensate: async () => f.execution().operation, settle: async () => f.execution().operation,
    };
    const perform = vi.fn(async (_step: string, execution: FleetExecution, signal: AbortSignal, claim: FleetOperationClaim) => {
      await f.maintenance.stop(execution, claim, signal); return { evidence: { stopped_verified: true } };
    });
    await new FleetExecutor(repository, { host: 'test-host', worker: 'worker',
      prepare: (execution, claim, signal) => f.maintenance.prepare(execution, claim, signal),
      finish: claim => f.maintenance.finish(claim), perform }).runOnce();
    expect(repository.prepare).toHaveBeenCalledExactlyOnceWith(f.claim);
    expect(repository.fail).not.toHaveBeenCalled(); expect(perform).toHaveBeenCalledTimes(1);
    expect(proveResume).not.toHaveBeenCalled(); expect(f.channelRequest).not.toHaveBeenCalled();
    expect(f.calls).toEqual(['hold', 'checkpoint', 'commit']);
    expect(checkpoint).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(AbortSignal), true);
    expect(f.execution().operation.steps.find(step => step.name === 'stop')?.status).toBe('succeeded');
  });
  it('rejects a stopped replay without its persisted checkpoint and aborts without committing', async () => {
    const f = fixture(); f.guard.first = { state: 'stopped' };
    f.update({ desired_revision: 1, steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'running' }] });
    const repository = { ...repositoryFor(f), prepare: async () => ({ operation: f.execution().operation, fenced_targets: [] }) };
    const regularStop = vi.fn(async () => ({ evidence: { stopped_verified: true } }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    checkpoint.mockRejectedValueOnce(new Error('persisted checkpoint missing'));
    await new FleetExecutor(repository, { host: 'test-host', worker: 'worker',
      prepare: (execution, claim, signal) => f.maintenance.prepare(execution, claim, signal),
      finish: claim => f.maintenance.finish(claim), perform: async (_step, execution, signal, claim) => {
        await f.maintenance.stop(execution, claim, signal); return regularStop();
      } }).runOnce();
    expect(checkpoint).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(AbortSignal), true);
    expect(regularStop).not.toHaveBeenCalled(); expect(repository.fail).toHaveBeenCalledOnce();
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('leaves human stop commands on their existing path without a maintenance checkpoint', async () => {
    const f = fixture(); f.update({ actor: { tenant_id: 'Steven', alias: 'one', actor_subject: 'console:human' } });
    await f.maintenance.stop(f.execution(), f.claim, new AbortController().signal);
    expect(checkpoint).not.toHaveBeenCalled(); expect(f.finish).not.toHaveBeenCalled();
  });
  it('rejects a stopped prepared runtime without its exact running stop authority', async () => {
    const f = fixture(); f.guard.first = { state: 'stopped' }; f.update({ desired_revision: 1 });
    await expect(f.maintenance.prepare(f.execution(), f.claim, new AbortController().signal)).rejects.toThrow('restart guard');
    f.update({ steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'stop', status: 'running' }] });
    const execution = f.execution();
    if (!execution.fleet_scope) throw new Error('prepared scope missing');
    execution.fleet_scope.claim_token = 'foreign';
    await expect(f.maintenance.prepare(execution, f.claim, new AbortController().signal)).rejects.toThrow('restart guard');
    expect(proveResume).not.toHaveBeenCalled(); expect(f.channelRequest).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledTimes(2); expect(f.finish).toHaveBeenLastCalledWith(false);
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
