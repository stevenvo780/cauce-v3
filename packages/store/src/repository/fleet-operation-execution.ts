import { FleetEvidenceSchema, FleetErrorSchema, sha256Hex, type FleetEvidence, type FleetError, type FleetOperation, type FleetStepName } from '@cauce/protocol';
import { withTransaction, type DatabaseClient } from '../db.js';
import { lockFleetRevision } from './fleet-operation-authority.js';
import { FleetOperationClaims } from './fleet-operation-claims.js';
import { FleetOperationError, publicFleetOperation, type FleetOperationClaim, type FleetOperationRow, type FleetExecutionState } from './fleet-operation-contracts.js';
import { prepareFleetDesired, previousFleetAgents, settleFleetDesired } from './fleet-operation-desired.js';
import { assertPrecedingSteps, fleetStep, lockFleetClaim, preparedState, recordFleetRevision, saveFleetState } from './fleet-operation-state.js';
import { fleetMembershipIntent, purgeFleetTarget } from './fleet-operation-lifecycle.js';
import { assertFleetHostBarrier, assertFleetSealedHostBarrier, hostStepEvidence, loadFleetHostScope, loadFleetHostSlices, planFleetHostSlices,
  readFleetGroupAgents, readFleetHostReceipts, usesFleetHostSlices, type FleetHostReceipt, type FleetHostSlice, type FleetHostStep } from './fleet-operation-hosts.js';

function stepEvidence(name: FleetStepName, input: FleetEvidence): FleetEvidence {
  const parsed = FleetEvidenceSchema.safeParse(input);
  if (!parsed.success) throw new FleetOperationError('invalid_input', 'fleet step evidence contains unsupported fields');
  const proof = parsed.data;
  const valid = name === 'artifacts' ? !!proof.artifact_sha256
    : name === 'credentials' ? !!proof.certificate_fingerprint
      : name === 'runtime' ? !!proof.runtime_digest
        : name === 'authenticate' ? proof.provider_verified === true
          : name === 'profile' ? proof.profile_verified === true
            : name === 'verify' ? proof.bootstrap_verified === true && proof.roundtrip_verified === true
              : name === 'purge' ? proof.stopped_verified === true && proof.revocation_verified === true
                : name === 'stop' ? proof.stopped_verified === true
                : name === 'revoke' ? proof.revocation_verified === true
                  : name === 'admission' ? proof.authority_verified === true && !!proof.artifact_sha256 : true;
  if (!valid) throw new FleetOperationError('invalid_input', 'fleet step requires verified effect evidence');
  return proof;
}

export abstract class FleetOperationExecution extends FleetOperationClaims {
  protected abstract readonly controllerHost: string | undefined;
  protected abstract readonly coordinatorEnabled: boolean;
  protected abstract readonly coordinatorHosts: readonly string[] | undefined;

  async hostSlices(claim: FleetOperationClaim): Promise<FleetHostSlice[]> {
    return withTransaction(this.pool, async client => loadFleetHostSlices(client, await lockFleetClaim(client, claim, true)));
  }
  async hostReceipts(claim: FleetOperationClaim, name: FleetHostStep): Promise<FleetHostReceipt[]> {
    return withTransaction(this.pool, async client => readFleetHostReceipts(client, await lockFleetClaim(client, claim, true), claim, name));
  }
  async completeHostStep(claim: FleetOperationClaim, name: FleetHostStep, host: string,
    digest: string, evidence: FleetEvidence): Promise<FleetOperation> {
    const proof = hostStepEvidence(name, evidence);
    return withTransaction(this.pool, async client => {
      const row = name === 'compensate' ? await lockFleetClaim(client, claim, true) : await this.current(client, claim);
      if (name === 'compensate') {
        if (!row.cancel_requested || row.status !== 'cancelling') throw new FleetOperationError('conflict', 'host compensation requires cancellation');
      } else {
        assertPrecedingSteps(row, name);
        if (!['running', 'succeeded'].includes(fleetStep(row, name).status)) throw new FleetOperationError('conflict', 'host step has not been started');
      }
      const slice = await loadFleetHostScope(client, row, host);
      if (slice.target_sha256 !== digest) throw new FleetOperationError('conflict', 'host receipt differs from its sealed scope');
      const receipt: FleetHostReceipt = { host_id: host, target_sha256: digest, step: name,
        epoch: claim.epoch, claim_token: claim.claim_token, evidence: proof };
      const prior = (await readFleetHostReceipts(client, row, claim, name)).find(entry => entry.host_id === host);
      if (prior) {
        if (sha256Hex(prior) !== sha256Hex(receipt)) throw new FleetOperationError('conflict', 'host effect evidence is immutable');
        return publicFleetOperation(row);
      }
      return publicFleetOperation(await saveFleetState(client, row, claim, 'step_completed', { step: name, host_receipt: receipt }));
    });
  }

  async execution(claim: FleetOperationClaim): Promise<FleetExecutionState> {
    return withTransaction(this.pool, async (client) => {
      const row = await lockFleetClaim(client, claim, true);
      return { operation: publicFleetOperation(row), request: row.request, ...await preparedState(client, row.id) };
    });
  }

  async prepare(claim: FleetOperationClaim): Promise<Omit<FleetExecutionState, 'request'>> {
    return withTransaction(this.pool, async (client) => {
      const row = await lockFleetClaim(client, claim);
      await lockFleetRevision(client, Number(row.desired_revision ?? row.expected_revision));
      if (row.desired_revision !== null) {
        return { operation: publicFleetOperation(row), ...await preparedState(client, row.id) };
      }
      const previous = await previousFleetAgents(client, row);
      const intent = await fleetMembershipIntent(client, row);
      const targets = await prepareFleetDesired(client, row, this.controllerHost, this.coordinatorEnabled, this.coordinatorHosts);
      row.desired_revision = await recordFleetRevision(client, row, 'prepare');
      const scopedAgents = row.request.kind === 'create' || row.request.kind === 'update'
        ? await readFleetGroupAgents(client, row.request) : previous;
      const slices = planFleetHostSlices(row, scopedAgents, previous);
      const name = row.steps[0]?.name;
      if (name !== 'prepare' && name !== 'fence') throw new FleetOperationError('conflict', 'operation has no durable preparation step');
      fleetStep(row, name).status = 'succeeded';
      const next = await saveFleetState(client, row, claim, 'step_completed', { step: name, fenced_targets: targets,
        previous_agents: previous, desired_memberships: intent, host_slices: slices, prepared_revision: Number(row.desired_revision) });
      return { operation: publicFleetOperation(next), fenced_targets: targets, previous_agents: previous, desired_memberships: intent };
    });
  }

  async startStep(claim: FleetOperationClaim, name: FleetStepName): Promise<FleetOperation> {
    return withTransaction(this.pool, async (client) => {
      const row = await this.current(client, claim);
      if (name === 'prepare' || name === 'fence') {
        throw new FleetOperationError('invalid_input', 'this step is controlled by the durable lifecycle transaction');
      }
      assertPrecedingSteps(row, name);
      const step = fleetStep(row, name);
      if (step.status === 'succeeded' || step.status === 'running') return publicFleetOperation(row);
      step.status = 'running';
      return publicFleetOperation(await saveFleetState(client, row, claim, 'step_started', { step: name }));
    });
  }

  async completeStep(claim: FleetOperationClaim, name: FleetStepName, evidence: FleetEvidence): Promise<FleetOperation> {
    const proof = stepEvidence(name, evidence);
    return withTransaction(this.pool, async (client) => {
      const row = await this.current(client, claim);
      if (name === 'prepare' || name === 'fence') {
        throw new FleetOperationError('invalid_input', 'this step is controlled by the durable lifecycle transaction');
      }
      assertPrecedingSteps(row, name);
      const step = fleetStep(row, name);
      if (step.status === 'succeeded') {
        if (sha256Hex(step.evidence ?? {}) !== sha256Hex(proof)) throw new FleetOperationError('conflict', 'completed step evidence is immutable');
        await assertFleetSealedHostBarrier(client, row, name, proof);
        return publicFleetOperation(row);
      }
      if (step.status !== 'running') throw new FleetOperationError('conflict', 'fleet step has not been started');
      const explicit = await readFleetHostReceipts(client, row, claim, name);
      const direct = !usesFleetHostSlices(row.request) && explicit.length === 0;
      let receipts: FleetHostReceipt[];
      if (!direct) receipts = await assertFleetHostBarrier(client, row, claim, name, proof);
      else {
        const slices = await loadFleetHostSlices(client, row); const slice = slices[0];
        if (slices.length !== 1 || slice?.host_id !== row.executor_host) throw new FleetOperationError('conflict', 'direct agent effect requires one exact executor host');
        receipts = [{ host_id: slice.host_id, target_sha256: slice.target_sha256, step: name,
          epoch: claim.epoch, claim_token: claim.claim_token, evidence: hostStepEvidence(name, proof) }];
      }
      if (name === 'purge') await purgeFleetTarget(client, row);
      step.status = 'succeeded'; step.evidence = proof;
      return publicFleetOperation(await saveFleetState(client, row, claim, 'step_completed', { step: name,
        host_barrier: { epoch: claim.epoch, claim_token: claim.claim_token, direct, receipts } }));
    });
  }

  async awaitAuth(claim: FleetOperationClaim): Promise<FleetOperation> {
    return withTransaction(this.pool, async (client) => {
      const row = await this.current(client, claim);
      const step = fleetStep(row, 'authenticate');
      if (step.status !== 'running' && step.status !== 'waiting') throw new FleetOperationError('conflict', 'authentication step is not active');
      step.status = 'waiting'; row.status = 'awaiting_auth'; row.error = { code: 'PROVIDER_AUTH_REQUIRED', step: 'authenticate', retryable: true };
      if (row.target.resource === 'agent') await client.query(`UPDATE agents SET lifecycle_state='auth_pending',enabled=false,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND alias=$2 AND purged_at IS NULL`, [row.target.tenant_id, row.target.alias]);
      return publicFleetOperation(await saveFleetState(client, row, claim, 'awaiting_auth', {}, true));
    });
  }

  async fail(claim: FleetOperationClaim, input: FleetError): Promise<FleetOperation> {
    const parsed = FleetErrorSchema.safeParse(input);
    if (!parsed.success) throw new FleetOperationError('invalid_input', 'fleet failure must use the typed error contract');
    return withTransaction(this.pool, async (client) => {
      const row = await lockFleetClaim(client, claim, true);
      row.status = row.cancel_requested ? 'cancelling' : 'failed'; row.error = parsed.data;
      if (parsed.data.step) fleetStep(row, parsed.data.step).status = 'failed';
      if (row.target.resource === 'agent') await client.query(`UPDATE agents SET enabled=false,lifecycle_state=CASE
        WHEN retired_at IS NULL THEN 'failed' ELSE 'retiring' END,updated_at=clock_timestamp() WHERE tenant_id=$1 AND alias=$2 AND purged_at IS NULL`,
      [row.target.tenant_id, row.target.alias]);
      return publicFleetOperation(await saveFleetState(client, row, claim, 'failed', { code: parsed.data.code }, true));
    });
  }

  async settle(claim: FleetOperationClaim): Promise<FleetOperation> {
    return withTransaction(this.pool, async (client) => {
      const row = await this.current(client, claim);
      if (row.steps.some((step) => step.status !== 'succeeded')) {
        throw new FleetOperationError('conflict', 'fleet operation still has unverified steps');
      }
      for (const step of row.steps.filter((step) => !['prepare', 'fence'].includes(step.name))) {
        stepEvidence(step.name, step.evidence ?? {});
        await assertFleetSealedHostBarrier(client, row, step.name, step.evidence ?? {});
      }
      await settleFleetDesired(client, row);
      row.desired_revision = await recordFleetRevision(client, row, 'settle'); row.applied_revision = row.desired_revision;
      row.status = 'succeeded'; row.error = null;
      return publicFleetOperation(await saveFleetState(client, row, claim, 'succeeded', {}, true));
    });
  }

  async compensate(claim: FleetOperationClaim, evidence: FleetEvidence = {}): Promise<FleetOperation> {
    const proof = FleetEvidenceSchema.safeParse(evidence);
    if (!proof.success) throw new FleetOperationError('invalid_input', 'compensation evidence contains unsupported fields');
    return withTransaction(this.pool, async (client) => {
      const row = await lockFleetClaim(client, claim, true);
      if (!row.cancel_requested) throw new FleetOperationError('conflict', 'compensation requires an operator cancellation');
      if (usesFleetHostSlices(row.request) && row.desired_revision !== null) {
        await assertFleetHostBarrier(client, row, claim, 'compensate', proof.data);
      }
      const attempted = (name: FleetStepName): boolean => row.steps.some((step) => step.name === name && step.status !== 'pending');
      if (attempted('runtime') && proof.data.stopped_verified !== true) throw new FleetOperationError('conflict', 'runtime compensation has not been verified');
      if ((attempted('credentials') || attempted('authenticate')) && proof.data.revocation_verified !== true) {
        throw new FleetOperationError('conflict', 'credential compensation has not been verified');
      }
      if (row.target.resource === 'agent') await client.query(`UPDATE agents SET enabled=false,
        lifecycle_state=CASE WHEN retired_at IS NULL THEN 'failed' ELSE 'retiring' END,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND alias=$2 AND purged_at IS NULL`, [row.target.tenant_id, row.target.alias]);
      for (const step of row.steps) if (step.status !== 'pending') step.status = 'compensated';
      row.status = 'cancelled'; row.error = { code: 'CANCELLED', retryable: false };
      if (row.desired_revision !== null) row.desired_revision = await recordFleetRevision(client, row, 'compensate');
      return publicFleetOperation(await saveFleetState(client, row, claim, 'cancelled', {}, true));
    });
  }

  private async current(client: DatabaseClient, claim: FleetOperationClaim): Promise<FleetOperationRow> {
    const row = await lockFleetClaim(client, claim);
    if (row.desired_revision === null) throw new FleetOperationError('conflict', 'fleet operation has not been prepared');
    await lockFleetRevision(client, Number(row.desired_revision));
    return row;
  }
}
