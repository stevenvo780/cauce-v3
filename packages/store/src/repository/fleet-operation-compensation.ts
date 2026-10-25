import { ConfigMutationSchema, FleetTargetSchema, type ConfigMutation, type FleetOperation, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol';
import { z } from 'zod';
import type { DatabaseClient } from '../db.js';
import { FleetOperationError, type FleetOperationRow, type FencedFleetTarget } from './fleet-operation-contracts.js';
import type { FleetMembershipIntent } from './fleet-operation-lifecycle.js';
import { sealFleetTargetSlice } from './fleet-operation-slice.js';

const FleetRevisionSchema = z.object({ resource: z.literal('fleet_operation'), action: z.enum(['prepare', 'settle', 'compensate']),
  operation_id: z.uuid(), target: FleetTargetSchema }).strict();

function touchesMembershipIntent(mutation: Exclude<ConfigMutation, { resource: 'batch' }>, target: Extract<FleetTarget, { resource: 'agent' }>, rooms: ReadonlySet<string>): boolean {
  if (mutation.resource === 'tenant') return mutation.id === target.tenant_id;
  if (mutation.resource === 'room') return mutation.tenant_id === target.tenant_id && rooms.has(mutation.id);
  return (mutation.resource === 'agent' || mutation.resource === 'membership')
    && mutation.tenant_id === target.tenant_id && mutation.alias === target.alias;
}

function invalidatesMembershipIntent(operation: unknown, source: FleetOperationRow, rooms: ReadonlySet<string>): boolean {
  const original = source.target;
  if (original.resource !== 'agent') return true;
  const mutation = ConfigMutationSchema.safeParse(operation);
  if (mutation.success) return (mutation.data.resource === 'batch' ? mutation.data.mutations : [mutation.data])
    .some(leaf => touchesMembershipIntent(leaf, original, rooms));
  const fleet = FleetRevisionSchema.safeParse(operation);
  if (!fleet.success) return true;
  const target = fleet.data.target;
  if (fleet.data.operation_id === source.id && fleet.data.action === 'compensate'
      && target.resource === 'agent' && target.tenant_id === original.tenant_id && target.alias === original.alias) return false;
  return target.tenant_id === original.tenant_id
    && (target.resource === 'tenant' || (target.resource === 'room' ? rooms.has(target.room_id) : target.alias === original.alias));
}

export async function cancelledFleetMembershipIntent(client: DatabaseClient, row: FleetOperationRow,
  previous: readonly Record<string, unknown>[], intent: FleetMembershipIntent[]): Promise<FleetMembershipIntent[]> {
  const target = row.target;
  if (row.kind !== 'start' || target.resource !== 'agent') return intent;
  const primary = previous.find(agent => agent.tenant_id === target.tenant_id && agent.alias === target.alias)?.primary_room_id;
  if (!intent.some(member => member.room_id === primary && !member.enabled)) return intent;
  const source = (await client.query<FleetOperationRow & { digest: string | null; prepared: {
    prepared_revision: number; desired_memberships: FleetMembershipIntent[];
    fenced_targets: FencedFleetTarget[]; previous_agents: Record<string, unknown>[];
  } }>(`SELECT operation.*,prepared.metadata AS prepared,seal.metadata->>'target_slice_sha256' AS digest
    FROM fleet_operations operation JOIN LATERAL (
      SELECT metadata FROM fleet_operation_events WHERE operation_id=operation.id AND event='step_completed'
        AND metadata->>'step'='prepare' ORDER BY id LIMIT 1) prepared ON true LEFT JOIN LATERAL (
      SELECT metadata FROM fleet_operation_events WHERE operation_id=operation.id AND metadata ? 'target_slice_sha256'
        ORDER BY id DESC LIMIT 1) seal ON true
    WHERE operation.company_id=$1 AND operation.target=$2::jsonb AND operation.id<>$3 AND operation.kind IN ('create','update')
    ORDER BY operation.created_at DESC,operation.id DESC LIMIT 1 FOR SHARE OF operation`,
  [row.company_id, JSON.stringify(target), row.id])).rows[0];
  if (source?.status !== 'cancelled') return intent;
  const prepared = source.prepared;
  if (typeof source.digest !== 'string' || !Number.isSafeInteger(prepared.prepared_revision) || prepared.prepared_revision < 0
      || prepared.prepared_revision > Number(row.expected_revision)
      || (await sealFleetTargetSlice(client, source, prepared.fenced_targets, prepared.previous_agents)).target_slice_sha256 !== source.digest) {
    throw new FleetOperationError('conflict', 'cancelled membership intent has no unchanged sealed configuration');
  }
  const rooms = new Set(intent.map(member => member.room_id));
  const history = (await client.query<{ operation: unknown }>(`SELECT operation FROM config_revisions
    WHERE id>$1 AND id<=$2 AND (company_id=$3 OR scope='platform' OR company_id IS NULL) ORDER BY id`,
  [prepared.prepared_revision, row.expected_revision, row.company_id])).rows;
  if (history.some(revision => invalidatesMembershipIntent(revision.operation, source, rooms))) {
    throw new FleetOperationError('conflict', 'configuration changed after the cancelled membership intent');
  }
  const active = (await client.query<{ room_id: string; role: string }>(`SELECT member.room_id,member.role FROM memberships member
    JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
    WHERE member.tenant_id=$1 AND member.alias=$2 AND member.retired_at IS NULL AND room.enabled AND room.retired_at IS NULL`,
  [target.tenant_id, target.alias])).rows;
  const recovered = prepared.desired_memberships;
  if (!recovered.some(member => member.room_id === primary && member.enabled)
      || recovered.some(member => member.tenant_id !== target.tenant_id || member.alias !== target.alias
        || !active.some(current => current.room_id === member.room_id && current.role === member.role))) {
    throw new FleetOperationError('conflict', 'cancelled membership intent differs from the current active memberships');
  }
  return intent.map(member => ({ ...member, enabled: recovered.find(desired => desired.room_id === member.room_id)?.enabled ?? member.enabled }));
}

export function canRestoreFleetUpdate(
  operation: Pick<FleetOperation, 'desired_revision' | 'steps'>, request: FleetOperationRequest,
  previous: readonly Record<string, unknown>[],
): boolean {
  if (request.kind !== 'update' || operation.desired_revision === null || previous.length !== 1
      || !operation.steps.some(step => step.name === 'prepare' && step.status === 'succeeded')
      || operation.steps.some(step => !['prepare', 'stop'].includes(step.name) && step.status !== 'pending')) return false;
  const agent = previous[0];
  const { target, parameters } = request;
  const placement = parameters.placement;
  return agent?.tenant_id === target.tenant_id && agent.alias === target.alias
    && agent.runtime_key === parameters.runtime_key && agent.runtime_mode === 'container'
    && placement.mode === 'container' && agent.host_id === placement.host_id
    && agent.container_name === placement.container_name && agent.runtime_user === placement.runtime_user
    && agent.home_directory === placement.home_directory && agent.state_directory === placement.state_directory;
}
