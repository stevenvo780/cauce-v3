import type { DatabaseClient } from '../db.js';
import { validateFleetTarget } from './fleet-operation-authority.js';
import { assertFleetOperationAuthority } from './fleet-operation-human.js';
import { FleetOperationError, type FleetOperationRow, type FencedFleetTarget } from './fleet-operation-contracts.js';
import { prepareFleetTransition, settleFleetTransition } from './fleet-operation-lifecycle.js';
import { admitFleetAgent } from './fleet-operation-admission.js';
export { admitFleetAgent } from './fleet-operation-admission.js';

export async function fleetAgentTargets(client: DatabaseClient, row: FleetOperationRow): Promise<FencedFleetTarget[]> {
  const target = row.target;
  const result = await client.query<{ tenant_id: string; alias: string }>(
    `SELECT agent.tenant_id,agent.alias FROM agents agent WHERE agent.tenant_id=$1
      AND ($2::text IS NULL OR agent.alias=$2)
      AND ($3::text IS NULL OR agent.primary_room_id=$3 OR EXISTS (
        SELECT 1 FROM memberships member WHERE member.tenant_id=agent.tenant_id AND member.alias=agent.alias AND member.room_id=$3))
      ORDER BY agent.alias FOR UPDATE OF agent`,
    [target.tenant_id, target.resource === 'agent' ? target.alias : null, target.resource === 'room' ? target.room_id : null]);
  return result.rows.map((identity) => ({ resource: 'agent', ...identity }));
}

export async function fenceFleetAgents(client: DatabaseClient, targets: FencedFleetTarget[]): Promise<void> {
  for (const target of targets) {
    const params = [target.tenant_id, target.alias];
    await client.query('UPDATE agents SET enabled=false,updated_at=clock_timestamp() WHERE tenant_id=$1 AND alias=$2', params);
    await client.query(`UPDATE connection_leases SET lease_until=clock_timestamp(),epoch=epoch+1,
      connection_token=gen_random_uuid() WHERE tenant_id=$1 AND alias=$2`, params);
    await client.query(`UPDATE deliveries SET status='retry',available_at=clock_timestamp(),last_ack_rank=0,
      claim_token=NULL,claim_expires_at=NULL,ack_deadline_at=NULL,consumer_instance_id=NULL,consumer_epoch=NULL,
      last_error='Fleet lifecycle fenced the delivery claim',updated_at=clock_timestamp()
      WHERE recipient_tenant=$1 AND recipient_alias=$2 AND status IN ('leased','accepted','started')`, params);
    await client.query(`UPDATE terminal_sessions SET revoked_at=clock_timestamp()
      WHERE tenant_id=$1 AND alias=$2 AND revoked_at IS NULL`, params);
    await client.query(`UPDATE terminal_control_holds SET released_at=clock_timestamp(),released_reason='fleet_fenced'
      WHERE tenant_id=$1 AND alias=$2 AND released_at IS NULL`, params);
    await client.query(`INSERT INTO cauce_oauth_grant_revocations(grant_id)
      SELECT id FROM cauce_oauth_grants WHERE tenant_id=$1 AND actor_alias=$2 ON CONFLICT DO NOTHING`, params);
    await client.query(`UPDATE cauce_oauth_tokens token SET revoked_at=clock_timestamp()
      FROM cauce_oauth_grants g WHERE token.grant_id=g.id AND g.tenant_id=$1 AND g.actor_alias=$2
        AND token.revoked_at IS NULL`, params);
    await client.query(`UPDATE secret_handoffs SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL AND read_at IS NULL
      AND ((to_tenant=$1 AND to_alias=$2) OR (from_tenant=$1 AND from_alias=$2))`, params);
  }
}

export async function prepareAgentDesired(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  const request = row.request;
  if ((request.kind !== 'create' && request.kind !== 'update') || request.target.resource !== 'agent') {
    throw new FleetOperationError('invalid_input', 'agent preparation requires declarative parameters');
  }
  const { target, parameters } = request;
  const prior = (await client.query<{ retired_at: Date | null }>(
    'SELECT retired_at FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE', [target.tenant_id, target.alias])).rows[0];
  if (prior?.retired_at) throw new FleetOperationError('conflict', 'restore the retired agent before updating it');
  await client.query('UPDATE memberships SET enabled=false WHERE tenant_id=$1 AND alias=$2', [target.tenant_id, target.alias]);
  for (const membership of parameters.memberships) {
    await client.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled) VALUES($1,$2,$3,$4,false)
      ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET role=EXCLUDED.role,enabled=false,retired_at=NULL,retired_enabled=NULL`,
    [target.tenant_id, membership.room_id, target.alias, membership.role]);
  }
  const placement = parameters.placement;
  const parametersList = [target.tenant_id, target.alias, parameters.harness_id, parameters.display_name ?? null, parameters.runtime_key,
    parameters.primary_room_id, placement.host_id, placement.mode, placement.container_name ?? `host:${placement.host_id}`,
    placement.runtime_user, placement.home_directory, placement.state_directory, placement.systemd_user ?? null,
    parameters.primary_account_id ?? null, parameters.model_id ?? null];
  const sql = request.kind === 'create' ? `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,runtime_key,primary_room_id,
      host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user,primary_account_id,model_id,lifecycle_state)
    VALUES($1,$2,$3,$4,false,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'provisioning')`
    : `UPDATE agents SET harness_id=$3,display_name=$4,enabled=false,runtime_key=$5,primary_room_id=$6,host_id=$7,
      runtime_mode=$8,container_name=$9,runtime_user=$10,home_directory=$11,state_directory=$12,systemd_user=$13,
      primary_account_id=$14,model_id=$15,lifecycle_state='provisioning',updated_at=clock_timestamp() WHERE tenant_id=$1 AND alias=$2`;
  await client.query(sql, parametersList);
}

export async function prepareFleetDesired(
  client: DatabaseClient, row: FleetOperationRow, controllerHost?: string,
): Promise<FencedFleetTarget[]> {
  const validated = await validateFleetTarget(client, row.request, controllerHost);
  if (!validated.preview.can_apply) throw new FleetOperationError('conflict', 'target still has durable dependencies');
  const targets = await fleetAgentTargets(client, row);
  await fenceFleetAgents(client, targets);
  if (row.kind === 'create' || row.kind === 'update') await prepareAgentDesired(client, row);
  else await prepareFleetTransition(client, row);
  await assertFleetOperationAuthority(client, row);
  return targets;
}

export async function previousFleetAgents(client: DatabaseClient, row: FleetOperationRow): Promise<Array<Record<string, unknown>>> {
  const targets = await fleetAgentTargets(client, row);
  const previous: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    const agent = (await client.query<Record<string, unknown>>(`SELECT tenant_id,alias,runtime_key,harness_id,
      host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user,
      primary_room_id,primary_account_id,model_id,enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2`,
    [target.tenant_id, target.alias])).rows[0];
    if (agent) previous.push(agent);
  }
  return previous;
}

export async function settleFleetDesired(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  if (row.kind === 'stop' || row.kind === 'retire' || row.kind === 'purge' || (row.kind === 'restore' && row.target.resource !== 'agent')) {
    await settleFleetTransition(client, row);
  } else await admitFleetAgent(client, row);
}
