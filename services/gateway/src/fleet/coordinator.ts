import { FleetEvidenceSchema, type FleetEvidence, type FleetOperation, type FleetStepName } from '@cauce/protocol';
import { aggregateHostEvidence, isRegistryDraft, selectFleetHostSlices, type FleetOperationClaim } from '@cauce/store';
import { providerIdentityPending, type FleetEffectResult, type FleetExecution } from './executor.js';
import { scopedFleetProviderAgents } from './accounts.js';

export interface CoordinatedHostSlice {
  host_id: string; target_sha256: string;
  placement_role?: 'source' | 'destination' | undefined;
  targets: { tenant_id: string; alias: string; runtime_key: string }[];
  agents: Record<string, unknown>[];
}
export interface CoordinatedHostReceipt { host_id: string; target_sha256: string; evidence: FleetEvidence; placement_role?: 'source' | 'destination' | undefined }
export interface FleetCoordinatorRepository {
  hostSlices(claim: FleetOperationClaim): Promise<CoordinatedHostSlice[]>;
  hostReceipts(claim: FleetOperationClaim, step: FleetStepName | 'compensate'): Promise<CoordinatedHostReceipt[]>;
  completeHostStep(claim: FleetOperationClaim, step: FleetStepName | 'compensate', host: string,
    digest: string, evidence: FleetEvidence): Promise<FleetOperation>;
}
export interface FleetCoordinatorTransport {
  perform(host: string, step: FleetStepName, execution: FleetExecution, signal: AbortSignal): Promise<FleetEffectResult>;
  compensate(host: string, execution: FleetExecution, signal: AbortSignal): Promise<FleetEvidence>;
  retire?(host: string, execution: FleetExecution, signal: AbortSignal): Promise<FleetEvidence>;
}
function unavailable(): Error { return new Error('Fleet host scope or effect is unavailable'); }
export function fleetHostInputs(targets: { tenant_id: string; alias: string }[],
  execution: Pick<FleetExecution, 'previous_agents' | 'desired_memberships'>): Pick<FleetExecution, 'fenced_targets' | 'previous_agents' | 'desired_memberships'> {
  const identities = new Set(targets.map(target => JSON.stringify([target.tenant_id, target.alias])));
  return {
    fenced_targets: targets.map(target => ({ resource: 'agent', tenant_id: target.tenant_id, alias: target.alias })),
    previous_agents: (execution.previous_agents ?? []).filter(agent => identities.has(JSON.stringify([agent.tenant_id, agent.alias]))
      && !isRegistryDraft({ runtime_key: agent.runtime_key as string | null, retired_at: null,
        enabled: agent.enabled === true, lifecycle_state: String(agent.lifecycle_state) })),
    ...(execution.desired_memberships === undefined ? {} : {
      desired_memberships: execution.desired_memberships.filter(member => identities.has(JSON.stringify([member.tenant_id, member.alias]))),
    }),
  };
}
export function fleetHostPacket(execution: FleetExecution, slice: CoordinatedHostSlice, claim: FleetOperationClaim): FleetExecution {
  const revision = execution.operation.desired_revision;
  if (revision === null || execution.operation.id !== claim.operation.id) throw unavailable();
  const snapshotAgents = execution.snapshot?.agents;
  const agentRows = Array.isArray(snapshotAgents) ? snapshotAgents.filter((row): row is Record<string, unknown> =>
    row !== null && typeof row === 'object' && !Array.isArray(row)) : [];
  const accountIds = new Set(scopedFleetProviderAgents(execution.request, slice.targets,
    execution.previous_agents ?? [], agentRows).map(agent => agent.primary_account_id));
  const local = fleetHostInputs(slice.targets, execution);
  local.previous_agents = (local.previous_agents ?? []).filter(agent => agent.host_id === slice.host_id);
  if (slice.placement_role !== undefined) {
    accountIds.clear();
    for (const agent of slice.agents) if (typeof agent.primary_account_id === 'string') accountIds.add(agent.primary_account_id);
  }
  return { ...execution,
    ...local,
    ...(slice.placement_role === 'source' && execution.snapshot !== undefined ? { snapshot: { ...execution.snapshot,
      agents: agentRows.filter(agent => !slice.targets.some(target => target.tenant_id === agent.tenant_id && target.alias === agent.alias)) } } : {}),
    ...(execution.request.kind !== 'restore' || execution.request.target.resource === 'agent' ? {} : {
      global_desired_memberships: (execution.desired_memberships ?? []).filter(member =>
        agentRows.some(agent => agent.tenant_id === member.tenant_id && agent.alias === member.alias)),
    }),
    ...(execution.trusted_accounts === undefined ? {} : {
      trusted_accounts: execution.trusted_accounts.filter(account => accountIds.has(account.id)),
    }),
    fleet_scope: { operation_id: execution.operation.id, host_id: slice.host_id, scope_sha256: slice.target_sha256,
      ...(slice.placement_role === undefined ? {} : { placement_role: slice.placement_role }),
      prepared_revision: revision, worker_id: claim.worker_id, claim_token: claim.claim_token, claim_epoch: claim.epoch },
  };
}
function aggregate(step: FleetStepName | 'compensate', receipts: CoordinatedHostReceipt[]): FleetEvidence {
  return aggregateHostEvidence(step, receipts);
}
function assertReceipts(slices: CoordinatedHostSlice[], receipts: CoordinatedHostReceipt[]): void {
  if (new Set(receipts.map(receipt => receipt.host_id)).size !== receipts.length
      || receipts.some(receipt => !slices.some(slice => slice.host_id === receipt.host_id
        && slice.target_sha256 === receipt.target_sha256 && slice.placement_role === receipt.placement_role))) throw unavailable();
}
export class FleetCoordinator {
  constructor(private readonly repository: FleetCoordinatorRepository, private readonly transport: FleetCoordinatorTransport) {}
  async perform(step: FleetStepName, execution: FleetExecution, signal: AbortSignal, claim: FleetOperationClaim): Promise<FleetEffectResult> {
    return this.run(step, execution, signal, claim);
  }
  async compensate(execution: FleetExecution, signal: AbortSignal, claim: FleetOperationClaim): Promise<FleetEvidence> {
    const result = await this.run('compensate', execution, signal, claim);
    if (result.awaiting_auth) throw unavailable();
    return result.evidence;
  }
  private async run(step: FleetStepName | 'compensate', execution: FleetExecution, signal: AbortSignal, claim: FleetOperationClaim): Promise<FleetEffectResult> {
    const slices = selectFleetHostSlices(await this.repository.hostSlices(claim), step);
    if (!slices.length || new Set(slices.map(slice => slice.host_id)).size !== slices.length) throw unavailable();
    let receipts = await this.repository.hostReceipts(claim, step);
    assertReceipts(slices, receipts);
    for (const slice of slices) {
      signal.throwIfAborted();
      const current = receipts.filter(receipt => receipt.host_id === slice.host_id);
      if (current.length > 1 || (current[0] && (current[0].target_sha256 !== slice.target_sha256
          || current[0].placement_role !== slice.placement_role))) throw unavailable();
      if (current.length === 1) continue;
      const packet = fleetHostPacket(execution, slice, claim);
      const result = step === 'compensate'
        ? { evidence: await this.transport.compensate(slice.host_id, packet, signal) }
        : await this.transport.perform(slice.host_id, step, packet, signal);
      signal.throwIfAborted();
      if (result.awaiting_auth || step === 'authenticate' && providerIdentityPending(execution)) {
        if (execution.request.target.resource !== 'agent' || slices.length !== 1 || step !== 'authenticate') throw unavailable();
        return { ...result, awaiting_auth: true };
      }
      const evidence = step === 'admission' ? { ...result.evidence, authority_verified: true } : result.evidence;
      await this.repository.completeHostStep(claim, step, slice.host_id, slice.target_sha256, FleetEvidenceSchema.parse(evidence));
      receipts = await this.repository.hostReceipts(claim, step);
      assertReceipts(slices, receipts);
    }
    const complete = slices.map(slice => {
      const matches = receipts.filter(receipt => receipt.host_id === slice.host_id && receipt.target_sha256 === slice.target_sha256
        && receipt.placement_role === slice.placement_role);
      if (matches.length !== 1) throw unavailable();
      const receipt = matches[0]; if (!receipt) throw unavailable(); return receipt;
    });
    return { evidence: aggregate(step, complete) };
  }
}
