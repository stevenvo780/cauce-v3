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
  if (request.action === 'rollback_credentials') {
    await assertFleetCompensationIntent(client, row, prepared);
  } else if (row.status !== 'running' || row.cancel_requested
      || !row.steps.some(step => ['stop', 'artifacts', 'credentials', 'runtime'].includes(step.name) && step.status === 'running')) {
    throw new FleetAuthorityError('AUTHORITY_REVOKED');
  }
}
