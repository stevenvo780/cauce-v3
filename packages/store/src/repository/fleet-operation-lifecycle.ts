import type { FleetOperationRequest, FleetTarget } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { configurationDependencies } from '../configuration/shared.js';
import { FleetOperationError, type FleetOperationRow, type FencedFleetTarget } from './fleet-operation-contracts.js';

export interface FleetMembershipIntent {
  tenant_id: string; room_id: string; alias: string; role: string; enabled: boolean;
}

function targetPredicate(target: FleetTarget): { predicate: string; params: string[] } {
  if (target.resource === 'agent') return { predicate: 'tenant_id=$1 AND alias=$2', params: [target.tenant_id, target.alias] };
  if (target.resource === 'room') return { predicate: 'tenant_id=$1 AND room_id=$2', params: [target.tenant_id, target.room_id] };
  return { predicate: 'tenant_id=$1', params: [target.tenant_id] };
}

async function prepareGroupAgents(client: DatabaseClient, row: FleetOperationRow, state: 'retiring' | 'draft'): Promise<void> {
  const target = row.target;
  if (target.resource === 'agent') return;
  await client.query(`UPDATE agents agent SET enabled=false,
    lifecycle_state=CASE WHEN agent.retired_at IS NULL THEN $3 ELSE agent.lifecycle_state END,updated_at=clock_timestamp()
    WHERE agent.tenant_id=$1 AND ($2::text IS NULL OR agent.primary_room_id=$2 OR EXISTS (
      SELECT 1 FROM memberships member WHERE member.tenant_id=agent.tenant_id AND member.alias=agent.alias AND member.room_id=$2))`,
  [target.tenant_id, target.resource === 'room' ? target.room_id : null, state]);
}

async function settleGroupAgents(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  const prepared = (await client.query<{ targets: FencedFleetTarget[] }>(`SELECT metadata->'fenced_targets' AS targets
    FROM fleet_operation_events WHERE operation_id=$1 AND event='step_completed'
      AND metadata->>'step' IN ('prepare','fence') ORDER BY id LIMIT 1`, [row.id])).rows[0];
  if (!prepared) throw new FleetOperationError('conflict', 'group lifecycle has no prepared agent scope');
  for (const target of prepared.targets) {
    if (target.tenant_id !== row.target.tenant_id) throw new FleetOperationError('conflict', 'prepared agent is outside the lifecycle scope');
    await client.query(`UPDATE agents SET enabled=false,lifecycle_state=CASE WHEN retired_at IS NULL THEN 'draft' ELSE 'retired' END,
      updated_at=clock_timestamp() WHERE tenant_id=$1 AND alias=$2`, [target.tenant_id, target.alias]);
  }
}

async function retirementStamp(client: DatabaseClient, target: FleetTarget): Promise<string> {
  const source = target.resource === 'agent' ? 'agents WHERE tenant_id=$1 AND alias=$2'
    : target.resource === 'room' ? 'rooms WHERE tenant_id=$1 AND id=$2' : 'tenants WHERE id=$1';
  const scope = targetPredicate(target);
  const row = (await client.query<{ stamp: string | null }>(`SELECT retired_at::text AS stamp FROM ${source}`, scope.params)).rows[0];
  if (!row?.stamp) throw new FleetOperationError('conflict', 'restore requires a retired target');
  return row.stamp;
}

export async function fleetMembershipIntent(client: DatabaseClient, row: FleetOperationRow): Promise<FleetMembershipIntent[]> {
  if (row.request.kind === 'create' || row.request.kind === 'update') {
    const target = row.request.target;
    return row.request.parameters.memberships.map((member) => ({ tenant_id: target.tenant_id,
      alias: target.alias, room_id: member.room_id, role: member.role, enabled: member.enabled ?? true }));
  }
  const scope = targetPredicate(row.target);
  const stamp = row.kind === 'restore' ? await retirementStamp(client, row.target) : undefined;
  return (await client.query<FleetMembershipIntent>(`SELECT tenant_id,room_id,alias,role,
    COALESCE(retired_enabled,enabled) AS enabled FROM memberships WHERE ${scope.predicate}
      ${stamp === undefined ? '' : `AND (retired_at IS NULL OR retired_at=$${String(scope.params.length + 1)}::timestamptz)`}
    ORDER BY room_id,alias FOR UPDATE`, stamp === undefined ? scope.params : [...scope.params, stamp])).rows;
}

export async function prepareFleetTransition(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  const { target, kind } = row;
  const scope = targetPredicate(target);
  if (kind === 'retire' || kind === 'purge') {
    await prepareGroupAgents(client, row, 'retiring');
    if (target.resource === 'agent') {
      await client.query(`UPDATE agents SET retired_at=COALESCE(retired_at,now()),lifecycle_state='retiring'
        WHERE tenant_id=$1 AND alias=$2`, scope.params);
    } else if (target.resource === 'room') {
      await client.query(`UPDATE rooms SET retired_enabled=COALESCE(retired_enabled,enabled),retired_at=COALESCE(retired_at,now()),enabled=false
        WHERE tenant_id=$1 AND id=$2`, scope.params);
    } else {
      await client.query(`UPDATE tenants SET retired_enabled=COALESCE(retired_enabled,enabled),retired_at=COALESCE(retired_at,now()),enabled=false WHERE id=$1`, scope.params);
      await client.query(`UPDATE rooms SET retired_enabled=COALESCE(retired_enabled,enabled),retired_at=COALESCE(retired_at,now()),enabled=false WHERE tenant_id=$1`, scope.params);
    }
    await client.query(`UPDATE memberships SET retired_enabled=COALESCE(retired_enabled,enabled),retired_at=COALESCE(retired_at,now()),enabled=false
      WHERE ${scope.predicate}`, scope.params);
    return;
  }
  if (kind === 'restore') {
    const stamp = await retirementStamp(client, target);
    if (target.resource === 'agent') {
      const restored = await client.query(`UPDATE agents SET retired_at=NULL,enabled=false,lifecycle_state='provisioning',updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND alias=$2 AND retired_at IS NOT NULL`, scope.params);
      if (restored.rowCount !== 1) throw new FleetOperationError('conflict', 'agent is not retired');
      await client.query(`UPDATE memberships SET enabled=false,retired_at=NULL,retired_enabled=NULL
        WHERE ${scope.predicate} AND retired_at=$3::timestamptz`, [...scope.params, stamp]);
    }
    else await prepareGroupAgents(client, row, 'draft');
    return;
  }
  if (kind === 'start' || kind === 'stop') {
    if (target.resource !== 'agent') throw new FleetOperationError('invalid_input', 'runtime control requires an agent');
    const updated = await client.query(`UPDATE agents SET lifecycle_state=$3,enabled=false,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND alias=$2 AND retired_at IS NULL`, [target.tenant_id, target.alias, kind === 'start' ? 'provisioning' : 'draft']);
    if (updated.rowCount !== 1) throw new FleetOperationError('conflict', 'runtime control requires a non-retired agent');
  }
}

export async function purgeFleetTarget(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  const dependencies = await fleetPurgeDependencies(client, row.request);
  if (dependencies.some((dependency) => dependency.blocking)) throw new FleetOperationError('conflict', 'purge target has durable references');
  const target = row.target;
  if (target.resource === 'agent') await client.query('DELETE FROM agents WHERE tenant_id=$1 AND alias=$2', [target.tenant_id, target.alias]);
  else if (target.resource === 'room') await client.query('DELETE FROM rooms WHERE tenant_id=$1 AND id=$2', [target.tenant_id, target.room_id]);
  else await client.query('DELETE FROM tenants WHERE id=$1', [target.tenant_id]);
}

export async function fleetPurgeDependencies(client: DatabaseClient, request: FleetOperationRequest) {
  const target = request.target;
  const mutation = target.resource === 'tenant' ? { resource: 'tenant', action: 'delete', id: target.tenant_id } as const
    : target.resource === 'room' ? { resource: 'room', action: 'delete', tenant_id: target.tenant_id, id: target.room_id } as const
      : { ...target, action: 'delete' } as const;
  const dependencies = await configurationDependencies(client, mutation);
  return dependencies.map((dependency) => target.resource === 'agent' && dependency.type === 'fleet_runtime_identities'
    ? { ...dependency, blocking: false } : dependency);
}

export async function settleFleetTransition(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  const { target, kind } = row;
  if (kind === 'purge') return;
  if (kind === 'retire' || kind === 'stop') {
    if (target.resource === 'agent') await client.query(`UPDATE agents SET enabled=false,lifecycle_state=$3,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND alias=$2`, [target.tenant_id, target.alias, kind === 'retire' ? 'retired' : 'draft']);
    else await settleGroupAgents(client, row);
    return;
  }
  if (kind === 'restore' && target.resource !== 'agent') {
    const stamp = await retirementStamp(client, target);
    if (target.resource === 'tenant') {
      await client.query(`UPDATE tenants SET enabled=retired_enabled,retired_at=NULL,retired_enabled=NULL WHERE id=$1 AND retired_at IS NOT NULL`, [target.tenant_id]);
      await client.query(`UPDATE rooms SET enabled=retired_enabled,retired_at=NULL,retired_enabled=NULL WHERE tenant_id=$1 AND retired_at=$2::timestamptz`, [target.tenant_id, stamp]);
    } else await client.query(`UPDATE rooms SET enabled=retired_enabled,retired_at=NULL,retired_enabled=NULL WHERE tenant_id=$1 AND id=$2 AND retired_at IS NOT NULL`,
      [target.tenant_id, target.room_id]);
    const scope = targetPredicate(target);
    await client.query(`UPDATE memberships SET enabled=retired_enabled,retired_at=NULL,retired_enabled=NULL WHERE ${scope.predicate}
      AND retired_at=$${String(scope.params.length + 1)}::timestamptz`, [...scope.params, stamp]);
    await settleGroupAgents(client, row);
  }
}
