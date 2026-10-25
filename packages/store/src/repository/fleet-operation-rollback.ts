import type { FleetError } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { FleetOperationError, type FleetOperationClaim, type FleetOperationRow, type FleetExecutionState } from './fleet-operation-contracts.js';
import { canRestoreFleetUpdate } from './fleet-operation-compensation.js';
import { lockFleetClaim, preparedState, saveFleetState } from './fleet-operation-state.js';
import { isFleetRecoveryProbe } from './fleet-operation-recovery.js';
import { isMaintenanceOperation } from './fleet-operation-maintenance.js';
import { fleetRollbackIntent, type FleetRollbackIntent } from './fleet-operation-rollback-intent.js';
import { assertFleetReplacementCommitBinding, fleetReplacementCommit } from './fleet-operation-retirement.js';
export { fleetRollbackIntent, fleetRollbackCompleted, type FleetRollbackIntent } from './fleet-operation-rollback-intent.js';

export function restoredFleetFailure(intent: FleetRollbackIntent): FleetError {
  return { ...intent.original_error, retryable: false };
}

export async function assertFleetCompensationIntent(client: DatabaseClient, row: FleetOperationRow,
  prepared: Pick<FleetExecutionState, 'previous_agents' | 'compensation_snapshot'>): Promise<FleetRollbackIntent | undefined> {
  if (await fleetReplacementCommit(client, row.id) !== undefined) throw new FleetOperationError('conflict', 'a committed replacement cannot be compensated');
  if (row.status !== 'cancelling') throw new FleetOperationError('conflict', 'compensation requires a pending restoration');
  const intent = await fleetRollbackIntent(client, row.id);
  if (!row.cancel_requested && (intent === undefined || prepared.compensation_snapshot?.snapshot_sha256 !== intent.snapshot_sha256
      || !canRestoreFleetUpdate({ desired_revision: row.desired_revision === null ? null : Number(row.desired_revision), steps: row.steps },
        row.request, prepared.previous_agents, prepared.compensation_snapshot))) {
    throw new FleetOperationError('conflict', 'automatic compensation requires its sealed durable rollback intent');
  }
  return intent;
}

export async function recordFleetFailure(client: DatabaseClient, claim: FleetOperationClaim, error: FleetError): Promise<FleetOperationRow> {
  const row = await lockFleetClaim(client, claim, true);
  if (await assertFleetReplacementCommitBinding(client, row) !== undefined) {
    row.status = 'running'; row.error = { ...error, retryable: true };
    return saveFleetState(client, row, claim, 'failed', { retirement: true, code: error.code }, true);
  }
  const wasCancelling = row.status === 'cancelling';
  const intent = await fleetRollbackIntent(client, row.id);
  const prepared = row.kind === 'update' && row.desired_revision !== null ? await preparedState(client, row.id) : undefined;
  const snapshot = prepared?.compensation_snapshot;
  const requestsRollback = !row.cancel_requested && !wasCancelling && intent === undefined && prepared !== undefined && snapshot !== undefined
    && canRestoreFleetUpdate({ desired_revision: row.desired_revision === null ? null : Number(row.desired_revision), steps: row.steps },
      row.request, prepared.previous_agents, snapshot);
  row.status = row.cancel_requested || intent !== undefined || requestsRollback ? 'cancelling' : 'failed'; row.error = error;
  if (error.step) {
    const step = row.steps.find(step => step.name === error.step);
    if (!step) throw new FleetOperationError('invalid_input', 'step is not declared by this operation');
    step.status = 'failed';
  }
  if (row.target.resource === 'agent' && !isFleetRecoveryProbe(row.request)
      && (!isMaintenanceOperation(row) || row.desired_revision !== null)
      && (row.kind !== 'recover' || row.desired_revision !== null)) await client.query(`UPDATE agents SET enabled=CASE WHEN $3 THEN enabled ELSE false END,lifecycle_state=CASE
    WHEN retired_at IS NULL THEN 'failed' ELSE 'retiring' END,updated_at=clock_timestamp() WHERE tenant_id=$1 AND alias=$2 AND purged_at IS NULL`,
  [row.target.tenant_id, row.target.alias, wasCancelling || requestsRollback]);
  const compensation = wasCancelling && (await client.query<{ cancelling: boolean }>(
    `SELECT COALESCE((metadata->>'cancelling')::boolean,false) AS cancelling FROM fleet_operation_events
      WHERE operation_id=$1 AND event='claimed' ORDER BY id DESC LIMIT 1`, [row.id])).rows[0]?.cancelling === true;
  return saveFleetState(client, row, claim, 'failed', { code: error.code, ...(compensation ? { compensation: true } : {}),
    ...(requestsRollback ? { rollback_requested: { original_error: error, snapshot_sha256: snapshot.snapshot_sha256 } } : {}) }, true);
}

/**
 * Whether a settled create or update describes exactly the configuration that a pending compensation of the same agent will
 * restore. The original runtime is restarted before the durable rows return to it, so its own settled operation no longer
 * matches the agent row; only a sealed rollback (or an explicit cancellation over a sealed snapshot) lets it keep waiting.
 */
export async function describesFleetCompensationTarget(client: DatabaseClient, settled: FleetOperationRow): Promise<boolean> {
  const request = settled.request;
  if (settled.status !== 'succeeded' || (request.kind !== 'create' && request.kind !== 'update')) return false;
  const pending = (await client.query<FleetOperationRow>(`SELECT * FROM fleet_operations WHERE company_id=$1 AND target=$2::jsonb
    AND kind='update' AND status='cancelling' AND id<>$3 FOR SHARE`, [settled.company_id, JSON.stringify(settled.target), settled.id])).rows;
  for (const row of pending) {
    const prepared = await preparedState(client, row.id);
    try { await assertFleetCompensationIntent(client, row, prepared); }
    catch (error) { if (error instanceof FleetOperationError) continue; throw error; }
    const previous = prepared.previous_agents[0];
    if (previous === undefined || prepared.compensation_snapshot === undefined
        || !canRestoreFleetUpdate({ desired_revision: row.desired_revision === null ? null : Number(row.desired_revision), steps: row.steps },
          row.request, prepared.previous_agents, prepared.compensation_snapshot)) continue;
    const desired = request.parameters;
    if (desired.runtime_key === previous.runtime_key && desired.harness_id === previous.harness_id
        && desired.primary_account_id === previous.primary_account_id && (desired.model_id ?? null) === (previous.model_id ?? null)
        && (desired.reasoning_effort ?? null) === (previous.reasoning_effort ?? null)) return true;
  }
  return false;
}
