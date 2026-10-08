import type { FleetStepName } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { lockFleetRevision, recordFleetEvent } from './fleet-operation-authority.js';
import { FleetOperationError, type FleetOperationClaim, type FleetOperationRow, type FencedFleetTarget } from './fleet-operation-contracts.js';
import type { FleetMembershipIntent } from './fleet-operation-lifecycle.js';
import { assertFleetOperationAuthority, loadFleetOrigin } from './fleet-operation-human.js';

export async function lockFleetClaim(client: DatabaseClient, claim: FleetOperationClaim, cancelling = false): Promise<FleetOperationRow> {
  await lockFleetRevision(client);
  const row = (await client.query<FleetOperationRow>(
    `SELECT * FROM fleet_operations WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND epoch=$4
      AND lease_expires_at>clock_timestamp() AND status IN ('running','cancelling') FOR UPDATE`,
    [claim.operation.id, claim.worker_id, claim.claim_token, claim.epoch])).rows[0];
  if (!row || (!cancelling && row.cancel_requested)) throw new FleetOperationError('conflict', 'fleet operation worker is fenced');
  await assertFleetOperationAuthority(client, row);
  return row;
}

export async function saveFleetState(
  client: DatabaseClient, row: FleetOperationRow, claim: FleetOperationClaim, event: string,
  metadata: Record<string, unknown> = {}, release = false,
): Promise<FleetOperationRow> {
  await assertFleetOperationAuthority(client, row);
  const next = (await client.query<FleetOperationRow>(
    `UPDATE fleet_operations SET status=$5,steps=$6::jsonb,error=$7::jsonb,
      desired_revision=$8,applied_revision=$9,version=version+1,updated_at=clock_timestamp(),
      worker_id=CASE WHEN $10 THEN NULL ELSE worker_id END,
      claim_token=CASE WHEN $10 THEN NULL ELSE claim_token END,
      lease_expires_at=CASE WHEN $10 THEN NULL ELSE lease_expires_at END
     WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND epoch=$4 AND lease_expires_at>clock_timestamp() RETURNING *`,
    [row.id, claim.worker_id, claim.claim_token, claim.epoch, row.status, JSON.stringify(row.steps), row.error === null ? null : JSON.stringify(row.error),
      row.desired_revision, row.applied_revision, release])).rows[0];
  if (!next) throw new FleetOperationError('conflict', 'fleet operation worker lease expired before commit');
  await recordFleetEvent(client, row.id, Number(next.version), event, metadata);
  return loadFleetOrigin(client, next);
}

export function fleetStep(row: FleetOperationRow, name: FleetStepName): FleetOperationRow['steps'][number] {
  const step = row.steps.find((step) => step.name === name);
  if (!step) throw new FleetOperationError('invalid_input', 'step is not declared by this operation');
  return step;
}

export function assertPrecedingSteps(row: FleetOperationRow, name: FleetStepName): void {
  const index = row.steps.findIndex((step) => step.name === name);
  if (index < 0 || row.steps.slice(0, index).some((step) => step.status !== 'succeeded')) {
    throw new FleetOperationError('conflict', 'preceding fleet steps have not succeeded');
  }
}

export async function recordFleetRevision(client: DatabaseClient, row: FleetOperationRow, phase: string): Promise<string> {
  const operation = { resource: 'fleet_operation', action: phase, operation_id: row.id, target: row.target };
  const inverse = { resource: 'fleet_operation', action: 'compensate', operation_id: row.id, target: row.target };
  const revision = (await client.query<{ id: string }>(
    `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      VALUES($1,$2,$3::jsonb,$4::jsonb,$5) RETURNING id::text`,
    [row.actor_tenant, row.actor_alias, JSON.stringify(operation), JSON.stringify(inverse), `fleet ${row.kind} ${phase}`])).rows[0];
  if (!revision) throw new Error('fleet desired revision insert returned no row');
  return revision.id;
}

export async function preparedState(client: DatabaseClient, id: string): Promise<{
  fenced_targets: FencedFleetTarget[]; previous_agents: Record<string, unknown>[]; desired_memberships: FleetMembershipIntent[];
}> {
  const event = (await client.query<{ metadata: { fenced_targets: FencedFleetTarget[]; previous_agents: Record<string, unknown>[]; desired_memberships: FleetMembershipIntent[] } }>(
    `SELECT metadata FROM fleet_operation_events WHERE operation_id=$1 AND event='step_completed'
      AND metadata->>'step' IN ('prepare','fence') ORDER BY id LIMIT 1`, [id])).rows[0];
  return { fenced_targets: event?.metadata.fenced_targets ?? [], previous_agents: event?.metadata.previous_agents ?? [], desired_memberships: event?.metadata.desired_memberships ?? [] };
}
