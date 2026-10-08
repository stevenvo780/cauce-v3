import type { DatabaseClient } from '../db.js';
import { FleetOperationError, type FleetOperationRow } from './fleet-operation-contracts.js';
import { preparedState } from './fleet-operation-state.js';

interface AdmissionAgent { primary_room_id: string; primary_account_id: string; harness_id: string }
interface AdmissionMembership { room_id: string; role: string; enabled: boolean; retired_at: Date | null; room_enabled: boolean; room_retired_at: Date | null }

export async function admitFleetAgent(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  const target = row.target;
  if (target.resource !== 'agent') throw new FleetOperationError('invalid_input', 'agent admission requires an agent target');
  const agent = (await client.query<AdmissionAgent>(
    `SELECT agent.primary_room_id,agent.primary_account_id,agent.harness_id FROM agents agent
      JOIN tenants tenant ON tenant.id=agent.tenant_id
      JOIN rooms room ON room.id=agent.primary_room_id AND room.tenant_id=agent.tenant_id
      JOIN memberships primary_member ON primary_member.tenant_id=agent.tenant_id
        AND primary_member.alias=agent.alias AND primary_member.room_id=agent.primary_room_id
      JOIN role_policies policy ON policy.role=primary_member.role
      JOIN harness_definitions harness ON harness.id=agent.harness_id
      JOIN provider_accounts account ON account.id=agent.primary_account_id
      WHERE agent.tenant_id=$1 AND agent.alias=$2 AND agent.retired_at IS NULL
        AND tenant.enabled AND tenant.retired_at IS NULL AND room.enabled AND room.retired_at IS NULL
        AND primary_member.retired_at IS NULL AND policy.allow_route AND harness.enabled AND account.enabled
        AND (account.payer_tenant_id=agent.tenant_id OR account.shared_with_pool)
      FOR UPDATE OF agent FOR SHARE OF tenant,room,primary_member,policy,harness,account`,
    [target.tenant_id, target.alias])).rows[0];
  if (!agent) throw new FleetOperationError('conflict', 'admission requires current tenant room routing harness and account authority');
  const prepared = await preparedState(client, row.id);
  const expected = row.request.kind === 'create' || row.request.kind === 'update' ? row.request.parameters
    : prepared.previous_agents.find((previous) => previous.tenant_id === target.tenant_id && previous.alias === target.alias);
  if (expected?.primary_room_id !== agent.primary_room_id || expected.harness_id !== agent.harness_id
      || (expected.primary_account_id ?? null) !== agent.primary_account_id) {
    throw new FleetOperationError('conflict', 'agent admission identity changed after preparation');
  }
  const intent = prepared.desired_memberships;
  if (!intent.some((member) => member.tenant_id === target.tenant_id && member.alias === target.alias
      && member.room_id === agent.primary_room_id && member.enabled)) {
    throw new FleetOperationError('conflict', 'primary membership is absent from the admission intent');
  }
  const memberships = (await client.query<AdmissionMembership>(`SELECT member.room_id,member.role,member.enabled,member.retired_at,
    room.enabled AS room_enabled,room.retired_at AS room_retired_at FROM memberships member
    JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
    JOIN role_policies policy ON policy.role=member.role
    WHERE member.tenant_id=$1 AND member.alias=$2 ORDER BY member.room_id
    FOR UPDATE OF member FOR SHARE OF room,policy`, [target.tenant_id, target.alias])).rows;
  for (const member of intent) {
    const current = memberships.find((membership) => membership.room_id === member.room_id);
    if (member.tenant_id !== target.tenant_id || member.alias !== target.alias || current?.role !== member.role
        || (member.enabled && (current.retired_at !== null || !current.room_enabled || current.room_retired_at !== null))) {
      throw new FleetOperationError('conflict', 'membership no longer matches the prepared admission intent');
    }
  }
  if (memberships.some((member) => member.enabled && !intent.some((desired) => desired.room_id === member.room_id))) {
    throw new FleetOperationError('conflict', 'an unprepared membership changed the admission scope');
  }
  for (const member of intent) {
    await client.query('UPDATE memberships SET enabled=$4 WHERE tenant_id=$1 AND alias=$2 AND room_id=$3',
      [target.tenant_id, target.alias, member.room_id, member.enabled]);
  }
  const admitted = await client.query(`UPDATE agents SET enabled=true,lifecycle_state='ready',updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND alias=$2 AND retired_at IS NULL`, [target.tenant_id, target.alias]);
  if (admitted.rowCount !== 1) throw new FleetOperationError('conflict', 'agent admission target is unavailable');
}
