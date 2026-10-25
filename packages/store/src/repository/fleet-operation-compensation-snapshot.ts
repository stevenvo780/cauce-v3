import { canonicallyEqual, FleetTargetSchema, sha256Hex, type FleetEvidence, type FleetOperation } from '@cauce/protocol';
import { z } from 'zod';
import type { DatabaseClient } from '../db.js';
import { FleetOperationError, type FleetCompensationSnapshot, type FleetOperationRow } from './fleet-operation-contracts.js';

const SnapshotSchema = z.object({
  version: z.literal(1), operation_id: z.uuid(), company_id: z.string().min(1),
  target: FleetTargetSchema.refine(target => target.resource === 'agent'),
  previous_agents: z.array(z.record(z.string(), z.unknown())).length(1),
  previous_memberships: z.array(z.record(z.string(), z.unknown())).max(1000),
  snapshot_canonical: z.string().max(2_000_000), snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const AGENT_COLUMNS = ['harness_id', 'display_name', 'enabled', 'runtime_key', 'primary_room_id', 'host_id', 'runtime_mode',
  'container_name', 'runtime_user', 'home_directory', 'state_directory', 'systemd_user', 'primary_account_id', 'model_id',
  'reasoning_effort', 'extensions', 'lifecycle_state', 'created_at', 'retired_at', 'purged_at'] as const;
const MEMBER_COLUMNS = ['room_id', 'role', 'enabled', 'created_at', 'retired_at', 'retired_enabled'] as const;

export function parseFleetCompensationSnapshot(value: unknown): FleetCompensationSnapshot | undefined {
  const parsed = SnapshotSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { snapshot_canonical, snapshot_sha256, ...body } = parsed.data;
  try {
    if (sha256Hex(snapshot_canonical) !== snapshot_sha256 || !canonicallyEqual(JSON.parse(snapshot_canonical), body)) return undefined;
  } catch { return undefined; }
  const agent = body.previous_agents[0];
  if (agent?.tenant_id !== body.target.tenant_id || agent.alias !== body.target.alias || agent.company_id !== body.company_id
      || AGENT_COLUMNS.some(column => !Object.hasOwn(agent, column))) return undefined;
  const rooms = new Set<string>();
  for (const member of body.previous_memberships) {
    if (member.tenant_id !== agent.tenant_id || member.alias !== agent.alias || typeof member.room_id !== 'string'
        || rooms.has(member.room_id) || MEMBER_COLUMNS.some(column => !Object.hasOwn(member, column))) return undefined;
    rooms.add(member.room_id);
  }
  return { ...parsed.data, target: parsed.data.target };
}

export function validateFleetCompensationSnapshot(value: unknown,
  operation: Pick<FleetOperation, 'id' | 'target'> & { company_id?: string },
  previousAgents?: readonly Record<string, unknown>[]): FleetCompensationSnapshot {
  const snapshot = parseFleetCompensationSnapshot(value);
  if (snapshot?.operation_id !== operation.id || !canonicallyEqual(snapshot.target, operation.target)
      || (operation.company_id !== undefined && snapshot.company_id !== operation.company_id)
      || (previousAgents !== undefined && !canonicallyEqual(snapshot.previous_agents, previousAgents))) {
    throw new FleetOperationError('conflict', 'replacement compensation snapshot is invalid or outside its prepared scope');
  }
  return snapshot;
}

export async function captureFleetCompensationSnapshot(client: DatabaseClient, row: FleetOperationRow,
  previous: Record<string, unknown>[]): Promise<FleetCompensationSnapshot | undefined> {
  if (row.request.kind !== 'update') return undefined;
  const target = row.request.target;
  const memberships = (await client.query<{ member: Record<string, unknown> }>(`SELECT to_jsonb(member) AS member
    FROM memberships member WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id FOR UPDATE OF member`,
  [target.tenant_id, target.alias])).rows.map(({ member }) => member);
  const body = { version: 1 as const, operation_id: row.id, company_id: row.company_id, target,
    previous_agents: previous, previous_memberships: memberships };
  const snapshot_canonical = JSON.stringify(body);
  return validateFleetCompensationSnapshot({ ...body, snapshot_canonical, snapshot_sha256: sha256Hex(snapshot_canonical) }, row, previous);
}

export function fleetReplacementRuntimeDigest(proof: {
  snapshot_sha256: string; original_container_id: string; checkpoint_sha256: string; authority_sha256: string;
}): string {
  return sha256Hex(['fleet-replacement-restored:v1', proof.snapshot_sha256, proof.original_container_id,
    proof.checkpoint_sha256, proof.authority_sha256].join('\n'));
}

export function assertFleetReplacementEvidence(row: FleetOperationRow, previous: readonly Record<string, unknown>[],
  value: unknown, evidence: FleetEvidence): FleetCompensationSnapshot {
  const snapshot = validateFleetCompensationSnapshot(value, row, previous);
  const restored = evidence.replacement_restored;
  const runtimeDigest = restored === undefined ? undefined : fleetReplacementRuntimeDigest(restored);
  if (restored?.snapshot_sha256 !== snapshot.snapshot_sha256 || evidence.stopped_verified !== true
      || evidence.revocation_verified !== true || restored.runtime_digest !== evidence.runtime_digest || restored.runtime_digest !== runtimeDigest) {
    throw new FleetOperationError('conflict', 'replacement runtime and authority restoration have not been verified');
  }
  return snapshot;
}

export async function restoreFleetCompensationSnapshot(client: DatabaseClient, snapshot: FleetCompensationSnapshot): Promise<void> {
  const previous = snapshot.previous_agents[0];
  if (!previous) throw new FleetOperationError('conflict', 'replacement compensation has no original agent');
  for (const member of snapshot.previous_memberships) {
    const restored = await client.query(`UPDATE memberships member SET role=original.role,enabled=original.enabled,
      created_at=original.created_at,retired_at=original.retired_at,retired_enabled=original.retired_enabled
      FROM jsonb_populate_record(NULL::memberships,$1::jsonb) original
      WHERE member.tenant_id=original.tenant_id AND member.alias=original.alias AND member.room_id=original.room_id`, [JSON.stringify(member)]);
    if (restored.rowCount !== 1) throw new FleetOperationError('conflict', 'an original membership is absent from the prepared replacement');
  }
  const restored = await client.query(`UPDATE agents agent SET harness_id=original.harness_id,display_name=original.display_name,
    enabled=original.enabled,runtime_key=original.runtime_key,primary_room_id=original.primary_room_id,host_id=original.host_id,
    runtime_mode=original.runtime_mode,container_name=original.container_name,runtime_user=original.runtime_user,
    home_directory=original.home_directory,state_directory=original.state_directory,systemd_user=original.systemd_user,
    primary_account_id=original.primary_account_id,model_id=original.model_id,reasoning_effort=original.reasoning_effort,
    extensions=original.extensions,lifecycle_state=original.lifecycle_state,updated_at=clock_timestamp()
    FROM jsonb_populate_record(NULL::agents,$1::jsonb) original
    WHERE agent.tenant_id=original.tenant_id AND agent.alias=original.alias AND agent.company_id=original.company_id
      AND agent.runtime_key=original.runtime_key AND agent.retired_at IS NULL AND agent.purged_at IS NULL`, [JSON.stringify(previous)]);
  if (restored.rowCount !== 1) throw new FleetOperationError('conflict', 'the original replacement agent is no longer restorable');
  await client.query(`DELETE FROM memberships WHERE tenant_id=$1 AND alias=$2 AND NOT (room_id=ANY($3::text[]))`,
    [snapshot.target.tenant_id, snapshot.target.alias, snapshot.previous_memberships.map(member => member.room_id)]);
}
