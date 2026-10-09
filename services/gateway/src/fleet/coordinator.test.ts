import { describe, expect, it } from 'vitest';
import type { FleetOperation, FleetOperationRequest, FleetEvidence } from '@cauce/protocol';
import type { FleetOperationClaim } from '@cauce/store';
import { FleetCoordinator, fleetHostInputs, fleetHostPacket, type CoordinatedHostReceipt, type CoordinatedHostSlice } from './coordinator.js';
import type { FleetExecution } from './executor.js';

function fixture() {
  const request: FleetOperationRequest = { kind: 'retire', target: { resource: 'room', tenant_id: 'Steven', room_id: 'team' },
    parameters: {}, expected_revision: 0, idempotency_key: 'retire-team-hosts' };
  const operation: FleetOperation = { id: '72000000-0000-4000-8000-000000000001', request_sha256: 'a'.repeat(64),
    actor: { tenant_id: 'Steven', alias: 'operator' }, target: request.target, kind: request.kind,
    status: 'running', version: 1, expected_revision: 0, desired_revision: 1, applied_revision: null,
    steps: [{ name: 'stop', status: 'running' }], error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const agents = ['a', 'b'].map(host => ({ tenant_id: 'Steven', alias: host, runtime_key: `runtime-${host}`, host_id: `host-${host}` }));
  const slices: CoordinatedHostSlice[] = agents.map((agent, index) => ({ host_id: agent.host_id, target_sha256: String(index + 1).repeat(64),
    agents: [agent], targets: [{ tenant_id: agent.tenant_id, alias: agent.alias, runtime_key: agent.runtime_key }] }));
  const claim: FleetOperationClaim = { operation, request, worker_id: 'controller', epoch: 1,
    claim_token: '72000000-0000-4000-8000-000000000002' };
  const execution: FleetExecution = { operation, request, previous_agents: agents,
    fenced_targets: agents.map(agent => ({ resource: 'agent', tenant_id: agent.tenant_id, alias: agent.alias })),
    snapshot: { agents } };
  const receipts: CoordinatedHostReceipt[] = []; const calls: string[] = [];
  const repository = { hostSlices: async () => slices, hostReceipts: async () => [...receipts],
    completeHostStep: async (_claim: FleetOperationClaim, _step: string, host: string, digest: string, evidence: FleetEvidence) => {
      calls.push(`receipt:${host}`); receipts.push({ host_id: host, target_sha256: digest, evidence }); return operation;
    } };
  const transport = { perform: async (host: string) => { calls.push(`effect:${host}`); return { evidence: { stopped_verified: true } }; },
    compensate: async (host: string) => { calls.push(`compensate:${host}`); return { stopped_verified: true, revocation_verified: true }; } };
  return { slices, claim, execution, receipts, calls, repository, transport };
}

describe('fleet host coordination', () => {
  it('drops adopted registry drafts from previous agents but keeps the fenced target', () => {
    const draft = { tenant_id: 'Steven', alias: 'drafted', runtime_key: null, enabled: false, lifecycle_state: 'draft', host_id: null };
    const live = { tenant_id: 'Steven', alias: 'live', runtime_key: 'live', enabled: true, lifecycle_state: 'ready', host_id: 'host-a' };
    const inputs = fleetHostInputs([{ tenant_id: 'Steven', alias: 'drafted' }, { tenant_id: 'Steven', alias: 'live' }],
      { previous_agents: [draft, live] });
    expect(inputs.previous_agents).toEqual([live]);
    expect(inputs.fenced_targets.map(target => target.alias)).toEqual(['drafted', 'live']);
  });
  it('requires the effect and receipt on every sealed host', async () => {
    const f = fixture(); const coordinator = new FleetCoordinator(f.repository, f.transport);
    expect(await coordinator.perform('stop', f.execution, new AbortController().signal, f.claim)).toEqual({ evidence: { stopped_verified: true } });
    expect(f.calls).toEqual(['effect:host-a', 'receipt:host-a', 'effect:host-b', 'receipt:host-b']);
  });
  it('resumes the missing host after a transport failure without repeating the recorded host', async () => {
    const f = fixture(); let unavailable = true;
    const transport = { ...f.transport, perform: async (host: string) => {
      if (host === 'host-b' && unavailable) throw new Error('host unavailable'); return f.transport.perform(host);
    } };
    const coordinator = new FleetCoordinator(f.repository, transport);
    await expect(coordinator.perform('stop', f.execution, new AbortController().signal, f.claim)).rejects.toThrow('host unavailable');
    expect(f.receipts).toHaveLength(1); unavailable = false;
    await coordinator.perform('stop', f.execution, new AbortController().signal, f.claim);
    expect(f.calls.filter(call => call === 'effect:host-a')).toHaveLength(1);
    expect(f.receipts).toHaveLength(2);
  });
  it('rejects a receipt for changed placements before any effect', async () => {
    const f = fixture(); f.receipts.push({ host_id: 'host-a', target_sha256: 'f'.repeat(64), evidence: { stopped_verified: true } });
    await expect(new FleetCoordinator(f.repository, f.transport).perform('stop', f.execution, new AbortController().signal, f.claim)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it('does not persist a receipt after the effect loses its claim signal', async () => {
    const f = fixture(); const abort = new AbortController();
    const transport = { ...f.transport, perform: async () => { abort.abort(); return { evidence: { stopped_verified: true } }; } };
    await expect(new FleetCoordinator(f.repository, transport).perform('stop', f.execution, abort.signal, f.claim)).rejects.toThrow();
    expect(f.receipts).toEqual([]);
  });
  it('rejects boolean proof that does not demonstrate the requested effect', async () => {
    const f = fixture(); const transport = { ...f.transport, perform: async () => ({ evidence: { stopped_verified: false } }) };
    await expect(new FleetCoordinator(f.repository, transport).perform('stop', f.execution, new AbortController().signal, f.claim)).rejects.toThrow();
  });
  it('requires compensation on every host and its stop and revocation evidence', async () => {
    const f = fixture();
    expect(await new FleetCoordinator(f.repository, f.transport).compensate(f.execution, new AbortController().signal, f.claim))
      .toEqual({ stopped_verified: true, revocation_verified: true });
    expect(f.calls).toEqual(['compensate:host-a', 'receipt:host-a', 'compensate:host-b', 'receipt:host-b']);
  });
  it('keeps the global snapshot but gives each host only its original placements and targets', () => {
    const f = fixture(); const slice = f.slices[0]; if (!slice) throw new Error('missing fixture');
    const packet = fleetHostPacket(f.execution, slice, f.claim);
    expect(packet.previous_agents).toEqual(slice.agents); expect(packet.fenced_targets).toHaveLength(1);
    expect(packet.snapshot).toEqual(f.execution.snapshot);
    expect(packet.fleet_scope).toEqual({ operation_id: f.claim.operation.id, host_id: 'host-a',
      scope_sha256: '1'.repeat(64), prepared_revision: 1, worker_id: 'controller', claim_token: f.claim.claim_token, claim_epoch: 1 });
  });
  it('gives every restoring host the same agent membership image and its own local intent', () => {
    const f = fixture(); f.execution.request = { kind: 'restore', target: f.claim.request.target, parameters: {},
      expected_revision: 0, idempotency_key: 'restore-group-members' };
    const membership = (alias: string) => ({ tenant_id: 'Steven', alias, room_id: 'team', role: 'agent', enabled: true });
    f.execution.desired_memberships = ['a', 'b', 'operator'].map(membership);
    const packets = f.slices.map(slice => fleetHostPacket(f.execution, slice, f.claim));
    expect(packets[0]?.desired_memberships).toEqual([membership('a')]);
    expect(packets[1]?.desired_memberships).toEqual([membership('b')]);
    for (const packet of packets) expect(packet.global_desired_memberships).toEqual([membership('a'), membership('b')]);
  });
  it('keeps an empty global agent image explicit when restoring only human memberships', () => {
    const f = fixture(); f.execution.request = { kind: 'restore', target: f.claim.request.target, parameters: {},
      expected_revision: 0, idempotency_key: 'restore-human-members' };
    f.execution.desired_memberships = [{ tenant_id: 'Steven', alias: 'operator', room_id: 'team', role: 'operator', enabled: true }];
    const slice = f.slices[0]; if (!slice) throw new Error('missing fixture');
    expect(fleetHostPacket(f.execution, slice, f.claim).global_desired_memberships).toEqual([]);
  });
});
