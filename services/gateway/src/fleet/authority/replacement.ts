import { assertFleetCompensationIntent, canRestoreFleetUpdate, lockPreparedFleetRevision, preparedState, publicFleetOperation, validateFleetCompensationSnapshot,
  type DatabaseClient, type FleetOperationRow } from '@cauce/store';
import { FleetAuthorityError, type AuthorityRequest } from './schemas.js';

export async function assertReplacementAuthority(client: DatabaseClient, row: FleetOperationRow, request: AuthorityRequest): Promise<void> {
  if (request.action !== 'checkpoint_credentials' && request.action !== 'rollback_credentials') return;
  const prepared = await preparedState(client, row.id);
  const snapshot = validateFleetCompensationSnapshot(prepared.compensation_snapshot, row, prepared.previous_agents);
  await lockPreparedFleetRevision(client, row, true);
  const previous = snapshot.previous_agents[0];
  if (!canRestoreFleetUpdate(publicFleetOperation(row), row.request, prepared.previous_agents, snapshot)
      || snapshot.snapshot_sha256 !== request.snapshot_sha256 || previous?.host_id !== request.scope.host_id
      || previous.runtime_key !== request.scope.runtime_key) throw new FleetAuthorityError('AUTHORITY_REVOKED');
  if (request.action === 'rollback_credentials' || lateCheckpoint(row)) {
    await assertFleetCompensationIntent(client, row, prepared);
  } else if (row.status !== 'running' || row.cancel_requested
      || !row.steps.some(step => ['stop', 'artifacts', 'credentials', 'runtime'].includes(step.name) && step.status === 'running')) {
    throw new FleetAuthorityError('AUTHORITY_REVOKED');
  }
}

/**
 * A compensation may checkpoint the original late only when the update failed before its stop completed and no later
 * step ever started: no credential was issued by this operation, so the inventory it pins is the original's (hades, 27-oct).
 */
export function lateCheckpoint(row: Pick<FleetOperationRow, 'status' | 'steps'>): boolean {
  return row.status === 'cancelling'
    && row.steps.some(step => step.name === 'stop' && step.status !== 'succeeded')
    && row.steps.every(step => ['prepare', 'stop'].includes(step.name) || step.status === 'pending');
}
