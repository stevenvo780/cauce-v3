import { FleetOperationRequestSchema, sha256Hex, type FleetOperationPreview, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { fleetPurgeDependencies } from './fleet-operation-lifecycle.js';
import { FleetOperationError } from './fleet-operation-contracts.js';

export function fleetRequest(value: unknown): FleetOperationRequest {
  const parsed = FleetOperationRequestSchema.safeParse(value);
  if (!parsed.success) throw new FleetOperationError('invalid_input', 'fleet operation request is invalid');
  return parsed.data;
}
export async function assertFleetAuthority(
  client: DatabaseClient, tenant: string, alias: string, target: FleetTarget, control = true,
): Promise<void> {
  const result = await client.query<{ is_hub: boolean; allow_read: boolean; allow_control: boolean }>(
    `SELECT tenant.is_hub,bool_or(policy.allow_read) AS allow_read,bool_or(policy.allow_control) AS allow_control
       FROM memberships membership JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       JOIN role_policies policy ON policy.role=membership.role
      WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled AND tenant.enabled AND room.enabled
      GROUP BY tenant.is_hub`, [tenant, alias]);
  const authority = result.rows[0];
  if (!authority || !(control ? authority.allow_control : authority.allow_read)
      || (!authority.is_hub && (target.tenant_id !== tenant || (control && target.resource !== 'room')))) {
    throw new FleetOperationError('forbidden', 'fleet operation is outside the current operator authority');
  }
}
export async function lockFleetRevision(client: DatabaseClient, expected?: number): Promise<number> {
  await client.query('SELECT pg_advisory_xact_lock(783_003_004)');
  const result = await client.query<{ revision: string }>('SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions');
  const revision = Number(result.rows[0]?.revision ?? 0);
  if (expected !== undefined && expected !== revision) {
    throw new FleetOperationError('conflict', 'configuration revision changed; preview the operation again');
  }
  return revision;
}
export function fleetSteps(request: FleetOperationRequest): FleetOperationPreview['steps'] {
  if (request.kind === 'restore' && request.target.resource !== 'agent') return ['prepare', 'artifacts', 'admission'];
  switch (request.kind) {
    case 'update': return ['prepare', 'stop', 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission'];
    case 'create': case 'restore': return ['prepare', 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission'];
    case 'start': return ['prepare', 'runtime', 'authenticate', 'profile', 'verify', 'admission'];
    case 'stop': return ['fence', 'stop', 'artifacts'];
    case 'retire': return ['fence', 'stop', 'revoke', 'artifacts'];
    case 'purge': return ['fence', 'stop', 'revoke', 'purge', 'artifacts'];
  }
}
export async function validateFleetTarget(
  client: DatabaseClient, request: FleetOperationRequest, controllerHost?: string, prepared = false,
): Promise<{ host: string; preview: FleetOperationPreview }> {
  const { target } = request;
  const tenant = (await client.query<{ enabled: boolean; retired_at: Date | null }>(
    'SELECT enabled,retired_at FROM tenants WHERE id=$1 FOR SHARE', [target.tenant_id])).rows[0];
  if (!tenant) throw new FleetOperationError('not_found', 'target tenant was not found');
  const activating = ['create', 'update', 'start', 'restore'].includes(request.kind);
  if (activating && !(request.kind === 'restore' && target.resource === 'tenant') && (!tenant.enabled || tenant.retired_at !== null)) {
    throw new FleetOperationError('conflict', 'target tenant is not active');
  }
  let host: string | undefined;
  if (target.resource === 'agent') {
    const agent = (await client.query<{ host_id: string | null; runtime_key: string | null; primary_room_id: string | null; harness_id: string }>(
      'SELECT host_id,runtime_key,primary_room_id,harness_id FROM agents WHERE tenant_id=$1 AND alias=$2', [target.tenant_id, target.alias])).rows[0];
    if (request.kind === 'create' && agent && !prepared) throw new FleetOperationError('conflict', 'agent identity already exists');
    if (request.kind !== 'create' && !agent) throw new FleetOperationError('not_found', 'target agent was not found');
    if (request.kind === 'create' || request.kind === 'update') {
      const parameters = request.parameters;
      if (parameters.memberships.find((member) => member.room_id === parameters.primary_room_id)?.enabled === false) {
        throw new FleetOperationError('conflict', 'primary membership must be enabled in the activation intent');
      }
      const harness = await client.query('SELECT 1 FROM harness_definitions WHERE id=$1 AND enabled FOR SHARE', [parameters.harness_id]);
      if (!harness.rowCount) throw new FleetOperationError('conflict', 'target harness is not enabled');
      if (agent?.runtime_key && agent.runtime_key !== parameters.runtime_key) throw new FleetOperationError('conflict', 'physical runtime identity is immutable');
      if (request.kind === 'create' && !prepared && (await client.query('SELECT 1 FROM fleet_runtime_identities WHERE runtime_key=$1 OR (tenant_id=$2 AND alias=$3)',
        [parameters.runtime_key, target.tenant_id, target.alias])).rowCount) throw new FleetOperationError('conflict', 'physical runtime identity is reserved');
      for (const membership of parameters.memberships) {
        const room = (await client.query<{ allow_route: boolean }>(`SELECT policy.allow_route FROM rooms room JOIN role_policies policy ON policy.role=$3
          WHERE room.id=$1 AND room.tenant_id=$2 AND room.enabled AND room.retired_at IS NULL FOR SHARE OF room,policy`,
        [membership.room_id, target.tenant_id, membership.role])).rows[0];
        if (!room || (membership.room_id === parameters.primary_room_id && !room.allow_route)) {
          throw new FleetOperationError('conflict', 'membership room or routing role is unavailable');
        }
      }
      if (parameters.primary_account_id && !(await client.query(
        'SELECT 1 FROM provider_accounts WHERE id=$1 AND enabled AND (payer_tenant_id=$2 OR shared_with_pool) FOR SHARE',
        [parameters.primary_account_id, target.tenant_id])).rowCount) throw new FleetOperationError('forbidden', 'provider account has no current payer consent');
      host = parameters.placement.host_id;
    } else {
      host = agent?.host_id ?? controllerHost;
      if (activating && !(await client.query(`SELECT 1 FROM rooms room CROSS JOIN harness_definitions harness
        WHERE room.tenant_id=$1 AND room.id=$2 AND room.enabled AND room.retired_at IS NULL
          AND harness.id=$3 AND harness.enabled FOR SHARE OF room,harness`,
      [target.tenant_id, agent?.primary_room_id, agent?.harness_id])).rowCount) {
        throw new FleetOperationError('conflict', 'primary room or harness is unavailable');
      }
    }
  } else {
    host = controllerHost;
    if (target.resource === 'room' && !(await client.query('SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2',
      [target.tenant_id, target.room_id])).rowCount) throw new FleetOperationError('not_found', 'target room was not found');
  }
  if (!host) throw new FleetOperationError('conflict', 'fleet controller placement is not configured');
  const dependencies = request.kind === 'purge' ? await fleetPurgeDependencies(client, request) : [];
  return { host, preview: { request_sha256: sha256Hex(request), expected_revision: request.expected_revision, target, kind: request.kind,
    steps: fleetSteps(request), dependencies, can_apply: !dependencies.some((dependency) => dependency.blocking) } };
}

export async function recordFleetEvent(
  client: DatabaseClient, id: string, version: number, event: string, metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query('INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,$2,$3,$4::jsonb)',
    [id, version, event, JSON.stringify(metadata)]);
}
