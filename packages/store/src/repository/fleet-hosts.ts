import { fleetHostUsable, type FleetHost, type FleetHostCreate, type FleetHostUpdate } from '@cauce/protocol';
import { withTransaction, type DatabasePool } from '../db.js';
import { FleetOperationError } from './fleet-operation-contracts.js';

const CONTROLLER_FRESH_SECONDS = 90;

interface HostRow {
  host_id: string; registered: boolean; display_name: string | null; notes: string | null; enabled: boolean | null;
  version: string | null; controller_status: FleetHost['status'] | null; controller_seen_at: Date | null; controller_fresh: boolean;
}
interface AgentRow { host_id: string; tenant_id: string; alias: string; enabled: boolean; online: boolean; last_heartbeat_at: Date | null }

async function loadFleetHosts(
  db: Pick<DatabasePool, 'query'>, approvedHostIds: readonly string[], onlyHost: string | null,
): Promise<FleetHost[]> {
  const hosts = await db.query<HostRow>(
    `WITH known AS (
       SELECT host_id FROM fleet_hosts
       UNION SELECT unnest($1::text[])
       UNION SELECT host_id FROM agents WHERE host_id IS NOT NULL AND purged_at IS NULL)
     SELECT known.host_id,(host.host_id IS NOT NULL) AS registered,host.display_name,host.notes,host.enabled,
            host.version::text AS version,host.controller_status,host.controller_seen_at,
            COALESCE(host.controller_seen_at > now() - make_interval(secs => $3),false) AS controller_fresh
       FROM known LEFT JOIN fleet_hosts host ON host.host_id=known.host_id
      WHERE $2::text IS NULL OR known.host_id=$2
      ORDER BY known.host_id`,
    [[...approvedHostIds], onlyHost, CONTROLLER_FRESH_SECONDS],
  );
  const agents = await db.query<AgentRow>(
    `SELECT agent.host_id,agent.tenant_id,agent.alias,agent.enabled,
            COALESCE(lease.lease_until > now(),false) AS online,lease.last_heartbeat_at
       FROM agents agent
       LEFT JOIN connection_leases lease ON lease.tenant_id=agent.tenant_id AND lease.alias=agent.alias
      WHERE agent.host_id IS NOT NULL AND agent.purged_at IS NULL AND ($1::text IS NULL OR agent.host_id=$1)
      ORDER BY agent.tenant_id,agent.alias`,
    [onlyHost],
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

async function loadFleetHost(db: Pick<DatabasePool, 'query'>, hostId: string, approvedHostIds: readonly string[]): Promise<FleetHost> {
  const host = (await loadFleetHosts(db, approvedHostIds, hostId))[0];
  if (!host) throw new FleetOperationError('not_found', 'fleet host was not found');
  return host;
}

export async function listFleetHosts(db: Pick<DatabasePool, 'query'>, options: { approvedHostIds: readonly string[] }): Promise<FleetHost[]> {
  return loadFleetHosts(db, options.approvedHostIds, null);
}

export async function createFleetHost(
  db: Pick<DatabasePool, 'query'>, input: FleetHostCreate, approvedHostIds: readonly string[] = [],
): Promise<FleetHost> {
  const inserted = await db.query(
    'INSERT INTO fleet_hosts(host_id,display_name,notes) VALUES($1,$2,$3) ON CONFLICT (host_id) DO NOTHING',
    [input.host_id, input.display_name, input.notes]);
  if (inserted.rowCount === 0) throw new FleetOperationError('conflict', 'fleet host already exists');
  return loadFleetHost(db, input.host_id, approvedHostIds);
}

export async function updateFleetHost(
  db: Pick<DatabasePool, 'query'>, hostId: string, input: FleetHostUpdate, approvedHostIds: readonly string[] = [],
): Promise<FleetHost> {
  const updated = await db.query(
    `UPDATE fleet_hosts SET display_name=COALESCE($3,display_name),notes=COALESCE($4,notes),enabled=COALESCE($5,enabled),
            version=version+1,updated_at=now()
      WHERE host_id=$1 AND version=$2`,
    [hostId, input.expected_version, input.display_name ?? null, input.notes ?? null, input.enabled ?? null]);
  if (updated.rowCount === 0) {
    const exists = await db.query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [hostId]);
    throw exists.rowCount === 0
      ? new FleetOperationError('not_found', 'fleet host was not found')
      : new FleetOperationError('conflict', 'fleet host version changed; reload and retry');
  }
  return loadFleetHost(db, hostId, approvedHostIds);
}

export async function deleteFleetHost(db: DatabasePool, hostId: string, expectedVersion: number): Promise<void> {
  await withTransaction(db, async (client) => {
    const row = (await client.query<{ version: string }>('SELECT version::text AS version FROM fleet_hosts WHERE host_id=$1 FOR UPDATE', [hostId])).rows[0];
    if (!row) throw new FleetOperationError('not_found', 'fleet host was not found');
    if (Number(row.version) !== expectedVersion) throw new FleetOperationError('conflict', 'fleet host version changed; reload and retry');
    const placed = await client.query('SELECT 1 FROM agents WHERE host_id=$1 AND purged_at IS NULL LIMIT 1', [hostId]);
    if (placed.rowCount) throw new FleetOperationError('conflict', 'the computer still has agents; move or remove them first');
    await client.query('DELETE FROM fleet_hosts WHERE host_id=$1', [hostId]);
  });
}

export async function recordFleetHostStatus(
  db: Pick<DatabasePool, 'query'>, hostId: string, status: Exclude<FleetHost['status'], 'unknown'>,
): Promise<void> {
  await db.query(
    `INSERT INTO fleet_hosts(host_id,display_name,controller_status,controller_seen_at) VALUES($1,$1,$2,now())
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
