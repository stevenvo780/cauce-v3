import { fleetHostUsable, type FleetHost, type FleetHostCreate, type FleetHostUpdate } from '@cauce/protocol';
import { assertPlatformAdmin, type CompanyAuthority } from '../company-authority.js';
import { withTransaction, type DatabaseClient, type DatabasePool } from '../db.js';
import { StoreError } from './errors.js';
import { FleetOperationError } from './fleet-operation-contracts.js';
import { lockFleetRevision } from './fleet-operation-authority.js';

const CONTROLLER_FRESH_SECONDS = 90;

interface HostRow {
  host_id: string; registered: boolean; display_name: string | null; notes: string | null; enabled: boolean | null;
  version: string | null; controller_status: FleetHost['status'] | null; controller_seen_at: Date | null; controller_fresh: boolean;
}
interface AgentRow { host_id: string; tenant_id: string; alias: string; enabled: boolean; online: boolean; last_heartbeat_at: Date | null }

/** Resolves the company authority of a verified console person inside the caller transaction. */
export type CompanyAuthoritySource = (client: DatabaseClient) => Promise<CompanyAuthority>;
export interface FleetHostScope { readonly authority: CompanyAuthoritySource; readonly approvedHostIds: readonly string[] }

/** Owners and administrators manage the computers of their company; only the platform registers or removes one. */
async function hostAuthority(client: DatabaseClient, scope: FleetHostScope, platform = false): Promise<CompanyAuthority> {
  const authority = await scope.authority(client);
  if (platform) assertPlatformAdmin(authority);
  else if (authority.scope !== 'company' && authority.scope !== 'platform') {
    throw new StoreError('forbidden', 'company authority is required for fleet hosts');
  }
  return authority;
}

async function auditHost(client: DatabaseClient, authority: CompanyAuthority, action: string, hostId: string): Promise<void> {
  await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,actor_human_id,metadata)
    VALUES($1,$2,$3,'allow',$4,$5,$6::jsonb)`, [authority.homeTenant, authority.alias, action, authority.actingCompany,
    authority.humanId, JSON.stringify({ host_id: hostId, platform_override: authority.platformOverride })]);
}

/**
 * A company sees its registered computers and the agents placed on them. An approved computer nobody
 * registered yet is shown to the platform, and to the only company while a single one exists, since
 * its first placement registers it there.
 */
async function loadFleetHosts(
  db: Pick<DatabasePool, 'query'>, authority: CompanyAuthority, approvedHostIds: readonly string[], onlyHost: string | null,
): Promise<FleetHost[]> {
  const hosts = await db.query<HostRow>(
    `WITH known AS (
       SELECT host_id FROM fleet_hosts WHERE company_id=$4
       UNION SELECT approved.host_id FROM unnest($1::text[]) approved(host_id)
        WHERE ($5::boolean OR (SELECT count(*) FROM companies)=1)
          AND NOT EXISTS (SELECT 1 FROM fleet_hosts host WHERE host.host_id=approved.host_id))
     SELECT known.host_id,(host.host_id IS NOT NULL) AS registered,host.display_name,host.notes,host.enabled,
            host.version::text AS version,host.controller_status,host.controller_seen_at,
            COALESCE(host.controller_seen_at > now() - make_interval(secs => $3),false) AS controller_fresh
       FROM known LEFT JOIN fleet_hosts host ON host.host_id=known.host_id
      WHERE $2::text IS NULL OR known.host_id=$2
      ORDER BY known.host_id`,
    [[...approvedHostIds], onlyHost, CONTROLLER_FRESH_SECONDS, authority.actingCompany, authority.role === 'platform_admin'],
  );
  const agents = await db.query<AgentRow>(
    `SELECT agent.host_id,agent.tenant_id,agent.alias,agent.enabled,
            COALESCE(lease.lease_until > now(),false) AS online,lease.last_heartbeat_at
       FROM agents agent
       LEFT JOIN connection_leases lease ON lease.tenant_id=agent.tenant_id AND lease.alias=agent.alias
      WHERE agent.host_id IS NOT NULL AND agent.purged_at IS NULL AND agent.company_id=$2 AND ($1::text IS NULL OR agent.host_id=$1)
      ORDER BY agent.tenant_id,agent.alias`,
    [onlyHost, authority.actingCompany],
  );
  const byHost = new Map<string, AgentRow[]>();
  for (const agent of agents.rows) byHost.set(agent.host_id, [...byHost.get(agent.host_id) ?? [], agent]);
  const approved = new Set(approvedHostIds);
  return hosts.rows.map((row): FleetHost => {
    const placed = byHost.get(row.host_id) ?? [];
    const heartbeats = placed.flatMap((agent) => agent.last_heartbeat_at === null ? [] : [agent.last_heartbeat_at.getTime()]);
    let effective: Pick<FleetHost, 'status' | 'status_source'> & { seen: Date | null };
    if (row.controller_fresh && row.controller_status !== null) {
      effective = { status: row.controller_status, status_source: 'controller', seen: row.controller_seen_at };
    } else if (placed.length > 0) {
      const online = placed.some((agent) => agent.online);
      effective = {
        status: online ? 'reachable' : placed.some((agent) => agent.enabled) ? 'unreachable' : 'unknown', status_source: 'agents',
        seen: heartbeats.length === 0 ? null : new Date(Math.max(...heartbeats)),
      };
    } else {
      effective = { status: 'unknown', status_source: 'none', seen: row.controller_seen_at };
    }
    return {
      host_id: row.host_id, display_name: row.display_name ?? row.host_id, notes: row.notes ?? '', enabled: row.enabled ?? true,
      status: effective.status, status_source: effective.status_source, last_seen_at: effective.seen?.toISOString() ?? null,
      registered: row.registered, approved: approved.has(row.host_id), version: Number(row.version ?? 0),
      agents: placed.map(({ tenant_id, alias, enabled, online }) => ({ tenant_id, alias, enabled, online })),
    };
  });
}

async function loadFleetHost(
  db: Pick<DatabasePool, 'query'>, authority: CompanyAuthority, hostId: string, approvedHostIds: readonly string[],
): Promise<FleetHost> {
  const host = (await loadFleetHosts(db, authority, approvedHostIds, hostId))[0];
  if (!host) throw new FleetOperationError('not_found', 'fleet host was not found');
  return host;
}

export async function listFleetHosts(pool: DatabasePool, scope: FleetHostScope): Promise<FleetHost[]> {
  return withTransaction(pool, async client => loadFleetHosts(client, await hostAuthority(client, scope), scope.approvedHostIds, null));
}

/** The platform registers a computer in the company it is acting for. */
export async function createFleetHost(pool: DatabasePool, input: FleetHostCreate, scope: FleetHostScope): Promise<FleetHost> {
  return withTransaction(pool, async client => {
    const authority = await hostAuthority(client, scope, true);
    const inserted = await client.query(
      'INSERT INTO fleet_hosts(host_id,display_name,notes,company_id) VALUES($1,$2,$3,$4) ON CONFLICT (host_id) DO NOTHING',
      [input.host_id, input.display_name, input.notes, authority.actingCompany]);
    if (inserted.rowCount === 0) throw new FleetOperationError('conflict', 'fleet host already exists');
    await auditHost(client, authority, 'fleet_host.create', input.host_id);
    return loadFleetHost(client, authority, input.host_id, scope.approvedHostIds);
  });
}

export async function updateFleetHost(
  pool: DatabasePool, hostId: string, input: FleetHostUpdate, scope: FleetHostScope,
): Promise<FleetHost> {
  return withTransaction(pool, async client => {
    const authority = await hostAuthority(client, scope);
    const updated = await client.query(
      `UPDATE fleet_hosts SET display_name=COALESCE($3,display_name),notes=COALESCE($4,notes),enabled=COALESCE($5,enabled),
              version=version+1,updated_at=now()
        WHERE host_id=$1 AND version=$2 AND company_id=$6`,
      [hostId, input.expected_version, input.display_name ?? null, input.notes ?? null, input.enabled ?? null, authority.actingCompany]);
    if (updated.rowCount === 0) {
      const exists = await client.query('SELECT 1 FROM fleet_hosts WHERE host_id=$1 AND company_id=$2', [hostId, authority.actingCompany]);
      throw exists.rowCount === 0
        ? new FleetOperationError('not_found', 'fleet host was not found')
        : new FleetOperationError('conflict', 'fleet host version changed; reload and retry');
    }
    await auditHost(client, authority, 'fleet_host.update', hostId);
    return loadFleetHost(client, authority, hostId, scope.approvedHostIds);
  });
}

/** Why a computer cannot be removed yet; the query reports the first dependency the operator has to clear. */
const HOST_DEPENDENCY_MESSAGE = {
  agents: 'La computadora todavía tiene agentes; muévelos o elimínalos antes de darla de baja.',
  operations: 'La computadora todavía tiene operaciones de flota en curso; espera a que terminen o cancélalas.',
  enrollment: 'La computadora tiene una invitación de inscripción pendiente; revócala antes de darla de baja.',
  quota: 'La computadora todavía aloja entornos de cuota; elimínalos antes de darla de baja.',
  backups: 'La computadora tiene copias de espacio registradas; no se puede dar de baja mientras existan.',
} as const;

/** Removing a computer is a platform action; its enrolled identity goes with it. */
export async function deleteFleetHost(pool: DatabasePool, hostId: string, expectedVersion: number, scope: FleetHostScope): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockFleetRevision(client);
    const authority = await hostAuthority(client, scope, true);
    const company = authority.actingCompany;
    const row = (await client.query<{ version: string }>('SELECT version::text AS version FROM fleet_hosts WHERE host_id=$1 AND company_id=$2 FOR UPDATE',
      [hostId, company])).rows[0];
    if (!row) throw new FleetOperationError('not_found', 'fleet host was not found');
    if (Number(row.version) !== expectedVersion) throw new FleetOperationError('conflict', 'fleet host version changed; reload and retry');
    await client.query(`UPDATE agent_quota_operations SET status='failed',error_code='EXPIRED',lease_until=NULL,updated_at=now()
      WHERE host_id=$1 AND company_id=$2 AND status IN ('pending','running') AND expires_at<=clock_timestamp()`, [hostId, company]);
    const quota = await client.query(`SELECT 1 FROM agent_quota_operations WHERE host_id=$1 AND company_id=$2
      AND status IN ('pending','running') LIMIT 1`, [hostId, company]);
    if (quota.rowCount) throw new FleetOperationError('conflict', 'La computadora tiene consultas de cuota en curso.');
    const blocker = (await client.query<{ kind: keyof typeof HOST_DEPENDENCY_MESSAGE }>(`SELECT kind FROM (
        SELECT 1 AS rank,'agents' AS kind FROM agents WHERE host_id=$1 AND purged_at IS NULL
        UNION ALL SELECT 2,'operations' FROM fleet_operations WHERE executor_host=$1 AND status NOT IN ('succeeded','failed','cancelled')
        UNION ALL SELECT 3,'enrollment' FROM fleet_host_enrollments
          WHERE host_id=$1 AND company_id=$2 AND state='pending' AND expires_at>now()
        UNION ALL SELECT 4,'quota' FROM quota_environments WHERE host_id=$1 AND company_id=$2 AND status<>'deleted'
        UNION ALL SELECT 5,'backups' FROM space_backups WHERE host_id=$1 AND company_id=$2
      ) dependency ORDER BY rank LIMIT 1`, [hostId, company])).rows[0];
    if (blocker) throw new FleetOperationError('conflict', HOST_DEPENDENCY_MESSAGE[blocker.kind]);
    await client.query(`UPDATE fleet_host_enrollments SET state='revoked'
      WHERE host_id=$1 AND company_id=$2 AND state='pending'`, [hostId, company]);
    await client.query(`DELETE FROM quota_environment_operations WHERE company_id=$2
      AND environment_id IN (SELECT id FROM quota_environments WHERE host_id=$1 AND company_id=$2 AND status='deleted')`, [hostId, company]);
    await client.query("DELETE FROM quota_environments WHERE host_id=$1 AND company_id=$2 AND status='deleted'", [hostId, company]);
    await client.query("DELETE FROM agent_quota_operations WHERE host_id=$1 AND company_id=$2 AND status IN ('done','failed')", [hostId, company]);
    await client.query('DELETE FROM fleet_hosts WHERE host_id=$1 AND company_id=$2', [hostId, company]);
    await auditHost(client, authority, 'fleet_host.delete', hostId);
  });
}

export async function recordFleetHostStatus(
  db: Pick<DatabasePool, 'query'>, hostId: string, status: Exclude<FleetHost['status'], 'unknown'>,
): Promise<void> {
  // A report registers an unknown computer only while a single company exists; afterwards the platform registers it.
  await db.query(
    `INSERT INTO fleet_hosts(host_id,display_name,controller_status,controller_seen_at) SELECT $1,$1,$2,now()
      WHERE EXISTS (SELECT 1 FROM fleet_hosts WHERE host_id=$1) OR (SELECT count(*) FROM companies)=1
     ON CONFLICT (host_id) DO UPDATE SET controller_status=EXCLUDED.controller_status,controller_seen_at=EXCLUDED.controller_seen_at`,
    [hostId, status]);
}

export async function fleetHostAvailability(
  db: Pick<DatabasePool, 'query'>, hostId: string,
): Promise<{ usable: boolean; reason?: 'disabled' | 'unreachable' }> {
  const row = (await db.query<{ enabled: boolean; blocked: boolean }>(
    `SELECT enabled,COALESCE(controller_status='unreachable' AND controller_seen_at > now() - make_interval(secs => $2),false) AS blocked
       FROM fleet_hosts WHERE host_id=$1`,
    [hostId, CONTROLLER_FRESH_SECONDS])).rows[0];
  if (!row) return { usable: true };
  const host = { enabled: row.enabled, status: row.blocked ? 'unreachable' : 'unknown', status_source: row.blocked ? 'controller' : 'none' } as const;
  if (fleetHostUsable(host)) return { usable: true };
  return { usable: false, reason: row.enabled ? 'unreachable' : 'disabled' };
}
