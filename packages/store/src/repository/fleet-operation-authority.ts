import { FleetOperationRequestSchema, sha256Hex, type FleetOperationPreview, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { companyRevision, lockCompanyAuthority, type CompanyAuthority } from '../company-authority.js';
import { providerAccountConsentSql } from '../configuration/company-scope.js';
import { StoreError } from './errors.js';
import { fleetPurgeDependencies } from './fleet-operation-lifecycle.js';
import { fleetPurgeResources } from './fleet-purge-resources.js';
import { FleetOperationError, isRegistryDraft } from './fleet-operation-contracts.js';
import { assertFleetHostAccess } from './fleet-operation-hosts.js';
import type { CompanyAuthoritySource } from './fleet-hosts.js';

export type FleetAuthorityScope = string | CompanyAuthoritySource;

export function fleetRequest(value: unknown): FleetOperationRequest {
  const parsed = FleetOperationRequestSchema.safeParse(value);
  if (!parsed.success) throw new FleetOperationError('invalid_input', 'fleet operation request is invalid');
  return parsed.data;
}
const CONSOLE_SUBJECT = /^console:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

function outsideAuthority(): never {
  throw new FleetOperationError('forbidden', 'fleet operation is outside the current operator authority');
}

/** The console person behind a fleet subject; any other subject acts without one. */
export function fleetHumanId(subject: string | undefined): string | undefined {
  return subject === undefined ? undefined : CONSOLE_SUBJECT.exec(subject)?.[1];
}

export async function resolveFleetAuthority(
  client: DatabaseClient, tenant: string, alias: string, subject?: string, scope?: FleetAuthorityScope,
): Promise<CompanyAuthority> {
  const humanId = fleetHumanId(subject);
  let authority: CompanyAuthority;
  try {
    authority = typeof scope === 'function' ? await scope(client) : await lockCompanyAuthority(client, {
      tenant, alias, ...(humanId === undefined ? {} : { humanId }), ...(scope === undefined ? {} : { requestedCompany: scope }),
    });
  }
  catch (error) { if (error instanceof StoreError && error.code === 'forbidden') outsideAuthority(); throw error; }
  if (authority.homeTenant !== tenant || authority.alias !== alias || authority.humanId !== (humanId ?? null)
      || (typeof scope === 'string' && authority.actingCompany !== scope)) outsideAuthority();
  return authority;
}

/** A selected company needs durable platform authority; a tenant operator controls only its rooms. */
export async function assertFleetAuthority(
  client: DatabaseClient, tenant: string, alias: string, target: FleetTarget, control = true, subject?: string, scope?: FleetAuthorityScope,
): Promise<CompanyAuthority> {
  const authority = await resolveFleetAuthority(client, tenant, alias, subject, scope);
  if (authority.scope === 'company' || authority.scope === 'platform') {
    const owner = (await client.query<{ company_id: string }>('SELECT company_id FROM tenants WHERE id=$1', [target.tenant_id])).rows[0];
    if (owner !== undefined && owner.company_id !== authority.actingCompany) outsideAuthority();
  } else if (target.tenant_id !== tenant || authority.scope !== 'tenant'
      || (control && (authority.role !== 'tenant_operator' || target.resource !== 'room'))) outsideAuthority();
  return authority;
}
/**
 * Holds the installation configuration lock and compares the revision of the target company, the one the console
 * previews against, so that another company's writes never invalidate this company's fleet work.
 */
export async function lockFleetRevision(client: DatabaseClient, expected?: number, company?: string): Promise<number> {
  await client.query('SELECT pg_advisory_xact_lock(783_003_004)');
  const revision = company === undefined
    ? Number((await client.query<{ revision: string }>('SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions')).rows[0]?.revision ?? 0)
    : await companyRevision(client, company);
  if (expected !== undefined && expected !== revision) {
    throw new FleetOperationError('conflict', 'configuration revision changed; preview the operation again');
  }
  return revision;
}
export function fleetSteps(request: FleetOperationRequest, relocation = false): FleetOperationPreview['steps'] {
  if (request.kind === 'restore' && request.target.resource !== 'agent') return ['prepare', 'artifacts', 'admission'];
  switch (request.kind) {
    case 'update': return ['prepare', 'stop', ...(relocation ? ['revoke' as const] : []), 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission'];
    case 'create': case 'restore': return ['prepare', 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission'];
    case 'start': return ['prepare', 'runtime', 'authenticate', 'profile', 'verify', 'admission'];
    case 'stop': return ['fence', 'stop', 'artifacts'];
    case 'retire': return ['fence', 'stop', 'revoke', 'artifacts'];
    case 'purge': return ['fence', 'stop', 'revoke', 'purge', 'artifacts'];
  }
}
export async function validateFleetTarget(
  client: DatabaseClient, request: FleetOperationRequest, controllerHost?: string, prepared = false, coordinatorEnabled = false,
  coordinatorHosts?: readonly string[],
): Promise<{ host: string; preview: FleetOperationPreview }> {
  const { target } = request;
  const tenant = (await client.query<{ enabled: boolean; retired_at: Date | null; purged_at: Date | null; company_id: string }>(
    'SELECT enabled,retired_at,purged_at,company_id FROM tenants WHERE id=$1 FOR SHARE', [target.tenant_id])).rows[0];
  if (!tenant) throw new FleetOperationError('not_found', 'target tenant was not found');
  if (tenant.purged_at) throw new FleetOperationError('conflict', 'purged tenant identity is permanent');
  const activating = ['create', 'update', 'start', 'restore'].includes(request.kind);
  if (activating && !(request.kind === 'restore' && target.resource === 'tenant') && (!tenant.enabled || tenant.retired_at !== null)) {
    throw new FleetOperationError('conflict', 'target tenant is not active');
  }
  let host: string | undefined;
  let relocation = false;
  if (target.resource === 'agent') {
    const agent = (await client.query<{ host_id: string | null; runtime_key: string | null; primary_room_id: string | null; harness_id: string;
      purged_at: Date | null; retired_at: Date | null; enabled: boolean; lifecycle_state: string }>(
      `SELECT host_id,runtime_key,primary_room_id,harness_id,purged_at,retired_at,enabled,lifecycle_state
         FROM agents WHERE tenant_id=$1 AND alias=$2`, [target.tenant_id, target.alias])).rows[0];
    if (agent?.purged_at) throw new FleetOperationError('conflict', 'purged agent identity is permanent');
    if (request.kind === 'create' && agent && !prepared && !isRegistryDraft(agent)) throw new FleetOperationError('conflict', 'agent identity already exists');
    if (request.kind !== 'create' && !agent) throw new FleetOperationError('not_found', 'target agent was not found');
    if (request.kind === 'create' || request.kind === 'update') {
      const parameters = request.parameters;
      // A computer serves one company; while only one exists, the first placement registers it there.
      const placed = (await client.query<{ company_id: string }>('SELECT company_id FROM fleet_hosts WHERE host_id=$1 FOR KEY SHARE',
        [parameters.placement.host_id])).rows[0];
      if (placed !== undefined && placed.company_id !== tenant.company_id) {
        throw new FleetOperationError('forbidden', 'fleet host belongs to another company');
      }
      if (placed === undefined && (await client.query('SELECT 1 FROM companies OFFSET 1 LIMIT 1')).rowCount) {
        throw new FleetOperationError('conflict', 'fleet host must be registered in the target company first');
      }
      if (parameters.memberships.find((member) => member.room_id === parameters.primary_room_id)?.enabled === false) {
        throw new FleetOperationError('conflict', 'primary membership must be enabled in the activation intent');
      }
      const harness = await client.query('SELECT 1 FROM harness_definitions WHERE id=$1 AND enabled FOR SHARE', [parameters.harness_id]);
      if (!harness.rowCount) throw new FleetOperationError('conflict', 'target harness is not enabled');
      if (agent?.runtime_key && agent.runtime_key !== parameters.runtime_key) throw new FleetOperationError('conflict', 'physical runtime identity is immutable');
      if (request.kind === 'update' && agent?.host_id !== parameters.placement.host_id) {
        if (!coordinatorEnabled || !agent?.host_id || !coordinatorHosts?.includes(agent.host_id)
            || !coordinatorHosts.includes(parameters.placement.host_id)) {
          throw new FleetOperationError('conflict', 'host relocation requires its approved source and destination coordinator');
        }
        const source = (await client.query<{ company_id: string }>('SELECT company_id FROM fleet_hosts WHERE host_id=$1 FOR KEY SHARE', [agent.host_id])).rows[0];
        if (source?.company_id !== tenant.company_id) throw new FleetOperationError('forbidden', 'relocation source belongs to another company');
        relocation = true;
      }
      if (request.kind === 'create' && !prepared && (await client.query('SELECT 1 FROM fleet_runtime_identities WHERE runtime_key=$1 OR (tenant_id=$2 AND alias=$3)',
        [parameters.runtime_key, target.tenant_id, target.alias])).rowCount) throw new FleetOperationError('conflict', 'physical runtime identity is reserved');
      for (const membership of parameters.memberships) {
        const room = (await client.query<{ allow_route: boolean }>(`SELECT policy.allow_route FROM rooms room JOIN role_policies policy ON policy.role=$3
          WHERE room.id=$1 AND room.tenant_id=$2 AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL FOR SHARE OF room,policy`,
        [membership.room_id, target.tenant_id, membership.role])).rows[0];
        if (!room || (membership.room_id === parameters.primary_room_id && !room.allow_route)) {
          throw new FleetOperationError('conflict', 'membership room or routing role is unavailable');
        }
      }
      if (parameters.primary_account_id && !(await client.query(
        `SELECT 1 FROM provider_accounts WHERE id=$1 AND enabled AND ${providerAccountConsentSql('provider_accounts', '$2')} FOR SHARE`,
        [parameters.primary_account_id, target.tenant_id])).rowCount) throw new FleetOperationError('forbidden', 'provider account has no current payer consent');
      host = parameters.placement.host_id;
    } else {
      host = agent?.host_id ?? controllerHost;
      if (activating && !(await client.query(`SELECT 1 FROM rooms room CROSS JOIN harness_definitions harness
        WHERE room.tenant_id=$1 AND room.id=$2 AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL
          AND harness.id=$3 AND harness.enabled FOR SHARE OF room,harness`,
      [target.tenant_id, agent?.primary_room_id, agent?.harness_id])).rowCount) {
        throw new FleetOperationError('conflict', 'primary room or harness is unavailable');
      }
    }
  } else {
    host = controllerHost;
    if (target.resource === 'room') {
      const room = (await client.query<{ purged_at: Date | null }>('SELECT purged_at FROM rooms WHERE tenant_id=$1 AND id=$2',
        [target.tenant_id, target.room_id])).rows[0];
      if (!room) throw new FleetOperationError('not_found', 'target room was not found');
      if (room.purged_at) throw new FleetOperationError('conflict', 'purged room identity is permanent');
    }
  }
  if (!host) throw new FleetOperationError('conflict', 'fleet controller placement is not configured');
  await assertFleetHostAccess(client, request, controllerHost, coordinatorEnabled, coordinatorHosts);
  if (coordinatorEnabled) {
    if (!controllerHost) throw new FleetOperationError('conflict', 'fleet controller placement is not configured');
    host = controllerHost;
  }
  const dependencies = request.kind === 'purge' ? await fleetPurgeDependencies(client, request) : [];
  const resources = request.kind === 'purge' && target.resource === 'agent' ? await fleetPurgeResources(client, target.tenant_id, target.alias) : [];
  return { host, preview: { request_sha256: sha256Hex(request), expected_revision: request.expected_revision, target, kind: request.kind,
    steps: fleetSteps(request, relocation), dependencies, can_apply: !dependencies.some((dependency) => dependency.blocking), resources } };
}

export async function recordFleetEvent(
  client: DatabaseClient, id: string, version: number, event: string, metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query('INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,$2,$3,$4::jsonb)',
    [id, version, event, JSON.stringify(metadata)]);
}
