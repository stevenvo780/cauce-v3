import { z } from 'zod';
import { FleetOperationRequestSchema, sha256Hex, type FleetOperation, type FleetOperationRequest } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { agentContextReconcileLockKey } from './agent-context-lock.js';
import { fleetSteps, lockFleetRevision, recordFleetEvent, validateFleetTarget } from './fleet-operation-authority.js';
import { FleetOperationError, publicFleetOperation, type FleetOperationRow } from './fleet-operation-contracts.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Identity = z.object({ host_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  company_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), enrollment_id: z.uuid(), key_fingerprint: Hash }).strict();
const Origin = Identity.omit({ company_id: true }).extend({ release_sha256: Hash, parameters_sha256: Hash }).strict();
type MaintenanceOrigin = z.infer<typeof Origin>;
export type HostMaintenanceIdentity = z.infer<typeof Identity>;
export type MaintenanceDeferReason = 'pending_deliveries' | 'provider_login' | 'composer_busy' | 'turn_active' | 'tui_unreadable' | 'preflight_unavailable';
export const HOST_MAINTENANCE_BATCH_SIZE = 32;
export class MaintenanceDeferredError extends FleetOperationError {
  constructor(readonly reason: MaintenanceDeferReason) {
    super('conflict', `host maintenance deferred: ${reason}`);
    this.name = 'MaintenanceDeferredError';
  }
}
export function maintenanceBackoffMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new FleetOperationError('invalid_input', 'maintenance attempt is invalid');
  return Math.min(30_000 * 2 ** Math.min(attempt - 1, 7), 3_600_000);
}
const origins = new WeakMap<FleetOperationRow, MaintenanceOrigin>();
export function getMaintenanceRelease(row: FleetOperationRow): string | undefined {
  return origins.get(row)?.release_sha256;
}
export function isMaintenanceOperation(row: { actor_subject?: string | undefined; actor?: { actor_subject?: string | undefined } }): boolean {
  return (row.actor_subject ?? row.actor?.actor_subject)?.startsWith('host:') === true;
}
export function loadMaintenanceOrigin(row: FleetOperationRow, metadata: Record<string, unknown> | undefined): void {
  origins.delete(row);
  if (metadata && Object.hasOwn(metadata, 'maintenance')) {
    const parsed = Origin.safeParse(metadata.maintenance);
    if (!parsed.success || !isMaintenanceOperation(row)) throw new FleetOperationError('forbidden', 'maintenance provenance is invalid');
    origins.set(row, parsed.data);
  } else if (isMaintenanceOperation(row)) throw new FleetOperationError('forbidden', 'maintenance provenance is missing');
}
async function assertIdentity(client: DatabaseClient, identity: HostMaintenanceIdentity): Promise<void> {
  if (!Identity.safeParse(identity).success) throw new FleetOperationError('forbidden', 'maintenance host identity is invalid');
  const active = await client.query(`SELECT 1 FROM fleet_host_identities identity
    JOIN fleet_host_enrollments enrollment ON enrollment.id=identity.enrollment_id
    JOIN fleet_hosts host ON host.host_id=identity.host_id AND host.company_id=identity.company_id
    WHERE identity.host_id=$1 AND identity.company_id=$2 AND identity.enrollment_id=$3::uuid
      AND identity.key_fingerprint=$4 AND identity.enabled AND host.enabled AND enrollment.state='enrolled'
      AND enrollment.host_id=identity.host_id AND enrollment.company_id=identity.company_id FOR SHARE OF host`,
  [identity.host_id, identity.company_id, identity.enrollment_id, identity.key_fingerprint]);
  if (!active.rowCount || !(await client.query<{ available: boolean }>(
    'SELECT cauce_lock_host_company($1) AS available', [identity.company_id])).rows[0]?.available) {
    throw new FleetOperationError('forbidden', 'maintenance host authority is unavailable');
  }
}
type AgentRequest = Extract<FleetOperationRequest, { kind: 'create' | 'update' }>;
async function canonicalRequest(client: DatabaseClient, target: AgentRequest['target'], revision: number,
  key: string, prepared?: AgentRequest['parameters']): Promise<AgentRequest> {
  const agent = (await client.query<Record<string, unknown>>(`SELECT agent.* FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
    WHERE agent.tenant_id=$1 AND agent.alias=$2 AND agent.retired_at IS NULL AND agent.purged_at IS NULL
      AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL`, [target.tenant_id, target.alias])).rows[0];
  if (agent?.runtime_mode !== 'container' || (!prepared && (agent.enabled !== true || agent.lifecycle_state !== 'ready'))) {
    throw new FleetOperationError('forbidden', 'maintenance target is not an active container runtime');
  }
  const memberships = (await client.query<{ room_id: string; role: string; enabled: boolean }>(
    `SELECT room_id,role,enabled FROM memberships WHERE tenant_id=$1 AND alias=$2 AND retired_at IS NULL ORDER BY room_id`,
    [target.tenant_id, target.alias])).rows.map(member => ({ ...member,
    ...(prepared ? { enabled: prepared.memberships.find(expected => expected.room_id === member.room_id)?.enabled ?? true } : {}) }));
  const parsed = FleetOperationRequestSchema.safeParse({ kind: 'update', target, expected_revision: revision, idempotency_key: key,
    parameters: { runtime_key: agent.runtime_key, harness_id: agent.harness_id, display_name: agent.display_name,
      primary_room_id: agent.primary_room_id, memberships, primary_account_id: agent.primary_account_id,
      model_id: agent.model_id, reasoning_effort: agent.reasoning_effort, extensions: agent.extensions,
      placement: { host_id: agent.host_id, mode: agent.runtime_mode, container_name: agent.container_name,
        runtime_user: agent.runtime_user, home_directory: agent.home_directory, state_directory: agent.state_directory,
        systemd_user: agent.systemd_user ?? 'stev' } } });
  if (!parsed.success || parsed.data.kind !== 'update') throw new FleetOperationError('forbidden', 'maintenance configuration is incomplete');
  return parsed.data;
}
export async function assertHostMaintenanceAuthority(client: DatabaseClient, row: FleetOperationRow, preparing = false, cancellingStale = false): Promise<void> {
  const origin = origins.get(row);
  if (!origin || row.kind !== 'update' || row.request.kind !== 'update' || row.target.resource !== 'agent'
      || row.actor_subject !== `host:${origin.host_id}:${origin.key_fingerprint}` || row.acting_company !== row.company_id
      || row.actor_tenant !== row.target.tenant_id || row.actor_alias !== row.target.alias
      || row.executor_host !== origin.host_id || row.request.parameters.placement.host_id !== origin.host_id
      || row.request.expected_revision !== Number(row.expected_revision) || row.cohort_key !== `fleet:${row.company_id}:${origin.host_id}`
      || sha256Hex(row.target) !== sha256Hex(row.request.target) || sha256Hex(row.request) !== row.request_hash
      || sha256Hex(row.request.parameters) !== origin.parameters_sha256) {
    throw new FleetOperationError('forbidden', 'maintenance operation is outside its exact target authority');
  }
  await assertIdentity(client, { host_id: origin.host_id, enrollment_id: origin.enrollment_id,
    key_fingerprint: origin.key_fingerprint, company_id: row.company_id });
  const tenant = (await client.query<{ company_id: string }>('SELECT company_id FROM tenants WHERE id=$1 FOR SHARE', [row.target.tenant_id])).rows[0];
  if (tenant?.company_id !== row.company_id) throw new FleetOperationError('forbidden', 'maintenance target company changed');
  if (cancellingStale && row.desired_revision === null
      && Number(row.expected_revision) !== await lockFleetRevision(client, undefined, row.company_id)) return;
  const current = await canonicalRequest(client, row.request.target, Number(row.expected_revision), row.request.idempotency_key,
    preparing || row.desired_revision !== null ? row.request.parameters : undefined);
  if (sha256Hex(current.parameters) !== origin.parameters_sha256) throw new FleetOperationError('forbidden', 'maintenance target configuration changed');
  await validateFleetTarget(client, row.request, origin.host_id, preparing || row.desired_revision !== null);
}
export async function assertHostMaintenanceIdle(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  if (!isMaintenanceOperation(row) || row.target.resource !== 'agent' || row.request.kind !== 'update') return;
  const params = [row.target.tenant_id, row.target.alias];
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [agentContextReconcileLockKey(row.target.tenant_id, row.target.alias)]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`connection-lease:${row.target.tenant_id}:${row.target.alias}`]);
  await client.query('SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 FOR UPDATE', params);
  await client.query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE', params);
  if ((await client.query(`SELECT 1 FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias=$2
    AND status IN ('pending','retry','leased','accepted','started') LIMIT 1`, params)).rowCount) {
    throw new MaintenanceDeferredError('pending_deliveries');
  }
  const reservations = (await client.query<{ reservation: { cohort?: unknown; state?: unknown } }>(
    `SELECT reservation.metadata->'provider_auth' AS reservation FROM fleet_operations operation
      JOIN LATERAL (SELECT metadata FROM fleet_operation_events WHERE operation_id=operation.id AND metadata ? 'provider_auth'
        ORDER BY id DESC LIMIT 1) reservation ON true WHERE operation.company_id=$1
      AND reservation.metadata->'provider_auth'->>'state' IS DISTINCT FROM 'released' LIMIT 1000`, [row.company_id])).rows;
  if (reservations.length === 1000) throw new MaintenanceDeferredError('provider_login');
  for (const { reservation } of reservations) {
    let cohort: unknown;
    try { cohort = JSON.parse(typeof reservation.cohort === 'string' ? reservation.cohort : 'null'); }
    catch { throw new MaintenanceDeferredError('provider_login'); }
    if (!Array.isArray(cohort) || cohort.length !== 3 || cohort.some(value => typeof value !== 'string')
        || (cohort[0] === row.executor_host && cohort[1] === row.request.parameters.placement.runtime_user)) {
      throw new MaintenanceDeferredError('provider_login');
    }
  }
}
export async function cancelStaleMaintenance(client: DatabaseClient, row: FleetOperationRow): Promise<boolean> {
  if (!isMaintenanceOperation(row) || !['queued', 'running'].includes(row.status) || row.desired_revision !== null || row.worker_id !== null
      || row.steps.some(step => step.status !== 'pending')
      || Number(row.expected_revision) === await lockFleetRevision(client, undefined, row.company_id)) return false;
  await assertHostMaintenanceAuthority(client, row, false, true);
  const next = (await client.query<{ version: string }>(`UPDATE fleet_operations SET status='cancelled',version=version+1,
    error='{"code":"CANCELLED","retryable":false}',updated_at=clock_timestamp() WHERE id=$1 RETURNING version`, [row.id])).rows[0];
  if (next) await recordFleetEvent(client, row.id, Number(next.version), 'cancelled', { maintenance_skipped: 'revision_changed' });
  return true;
}
export async function enqueueHostMaintenance(client: DatabaseClient, identity: HostMaintenanceIdentity,
  releaseSha256: string): Promise<{ operations: FleetOperation[] }> {
  if (!Hash.safeParse(releaseSha256).success) throw new FleetOperationError('invalid_input', 'maintenance release digest is invalid');
  const revision = await lockFleetRevision(client, undefined, identity.company_id);
  await assertIdentity(client, identity);
  const targets = (await client.query<{ tenant_id: string; alias: string }>(`SELECT agent.tenant_id,agent.alias FROM agents agent
    JOIN tenants tenant ON tenant.id=agent.tenant_id WHERE tenant.company_id=$1 AND tenant.enabled AND tenant.retired_at IS NULL
      AND agent.host_id=$2 AND agent.runtime_mode='container' AND agent.enabled AND agent.lifecycle_state='ready'
      AND agent.retired_at IS NULL AND agent.purged_at IS NULL AND agent.harness_id IN ('codex','claude','grok','muse')
    ORDER BY COALESCE((SELECT max(operation.created_at) FROM fleet_operations operation
      WHERE operation.target->>'resource'='agent' AND operation.target->>'tenant_id'=agent.tenant_id
        AND operation.target->>'alias'=agent.alias), '-infinity'::timestamptz),
      agent.tenant_id,agent.alias LIMIT 1024`, [identity.company_id, identity.host_id])).rows;
  const operations: FleetOperation[] = [];
  let created = 0;
  for (const target of targets) {
    if (created >= HOST_MAINTENANCE_BATCH_SIZE) break;
    const targetIdentity = { resource: 'agent' as const, ...target };
    const active = (await client.query<FleetOperationRow>(`SELECT * FROM fleet_operations WHERE target_key=$1
      AND status NOT IN ('cancelled','succeeded') FOR UPDATE`, [sha256Hex(targetIdentity)])).rows[0];
    if (active) {
      const event = (await client.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM fleet_operation_events WHERE operation_id=$1 AND event='queued' ORDER BY id LIMIT 1`, [active.id])).rows[0];
      if (event) {
        if (typeof event.metadata.actor_subject === 'string') active.actor_subject = event.metadata.actor_subject;
        if (typeof event.metadata.acting_company === 'string') active.acting_company = event.metadata.acting_company;
        loadMaintenanceOrigin(active, event.metadata);
      }
      if (!isMaintenanceOperation(active)) continue;
      if (active.status === 'queued' && active.desired_revision === null && active.worker_id === null
          && Number(active.expected_revision) !== revision && active.steps.every(step => step.status === 'pending')) await cancelStaleMaintenance(client, active);
      else { if (operations.length < HOST_MAINTENANCE_BATCH_SIZE) operations.push(publicFleetOperation(active)); continue; }
    }
    let request: AgentRequest;
    try { request = await canonicalRequest(client, targetIdentity, revision, 'maintenance_pending'); }
    catch (error) { if (error instanceof FleetOperationError) continue; throw error; }
    const parametersHash = sha256Hex(request.parameters);
    const satisfied = await client.query(`SELECT 1 FROM fleet_operations operation JOIN fleet_operation_events origin ON origin.operation_id=operation.id
      AND origin.event='queued' WHERE operation.target_key=$1 AND origin.metadata->'maintenance'->>'release_sha256'=$2
        AND origin.metadata->'maintenance'->>'parameters_sha256'=$3
        AND operation.id=(SELECT id FROM fleet_operations WHERE target_key=$1 ORDER BY created_at DESC,id DESC LIMIT 1)
        AND (operation.status='succeeded' OR (operation.status='cancelled'
          AND EXISTS(SELECT 1 FROM fleet_operation_events skipped WHERE skipped.operation_id=operation.id
            AND skipped.metadata->>'maintenance_skipped'='runtime_current'))) LIMIT 1`, [sha256Hex(targetIdentity), releaseSha256, parametersHash]);
    if (satisfied.rowCount) continue;
    const predecessor = (await client.query<{ id: string }>('SELECT id FROM fleet_operations WHERE target_key=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
      [sha256Hex(targetIdentity)])).rows[0]?.id ?? null;
    request.idempotency_key = `maintenance_${sha256Hex({ target: targetIdentity, revision, releaseSha256, parametersHash, identity, predecessor })}`;
    const prior = (await client.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE actor_tenant=$1 AND actor_alias=$2 AND idempotency_key=$3',
      [target.tenant_id, target.alias, request.idempotency_key])).rows[0];
    if (prior) continue;
    try { await validateFleetTarget(client, request, identity.host_id); }
    catch (error) { if (error instanceof FleetOperationError) continue; throw error; }
    const row = (await client.query<FleetOperationRow>(`INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,
      executor_host,kind,request,request_hash,idempotency_key,expected_revision,steps,company_id)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,'update',$7::jsonb,$8,$9,$10,$11::jsonb,$12) RETURNING *`,
    [target.tenant_id, target.alias, JSON.stringify(targetIdentity), sha256Hex(targetIdentity), `fleet:${identity.company_id}:${identity.host_id}`,
      identity.host_id, JSON.stringify(request), sha256Hex(request), request.idempotency_key, revision,
      JSON.stringify(fleetSteps(request).map(name => ({ name, status: 'pending' }))), identity.company_id])).rows[0];
    if (!row) throw new Error('maintenance operation insert returned no row');
    row.actor_subject = `host:${identity.host_id}:${identity.key_fingerprint}`;
    await recordFleetEvent(client, row.id, Number(row.version), 'queued', { acting_company: identity.company_id, actor_subject: row.actor_subject,
      maintenance: { host_id: identity.host_id, enrollment_id: identity.enrollment_id, key_fingerprint: identity.key_fingerprint,
        release_sha256: releaseSha256, parameters_sha256: parametersHash } });
    if (operations.length === HOST_MAINTENANCE_BATCH_SIZE) operations.pop();
    operations.push(publicFleetOperation(row)); created++;
  }
  return { operations };
}
