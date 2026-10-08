import type { DatabaseClient } from '../db.js';
import { assertFleetAuthority } from './fleet-operation-authority.js';
import { FleetOperationError, type FleetOperationRow } from './fleet-operation-contracts.js';

export async function assertFleetHumanAuthority(
  client: DatabaseClient, tenant: string, alias: string, subject?: string, control = true,
): Promise<void> {
  if (subject === undefined) return;
  const match = /^console:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(subject);
  if (!match) throw new FleetOperationError('forbidden', 'fleet human authority is unavailable');
  const account = (await client.query<{ active: boolean; role: string; tenant_id: string; alias: string }>(
    'SELECT active,role,tenant_id,alias FROM console_users WHERE id=$1::uuid FOR SHARE', [match[1]])).rows[0];
  if (!account?.active || (control && account.role !== 'operator') || account.tenant_id !== tenant || account.alias !== alias) {
    throw new FleetOperationError('forbidden', 'fleet human authority is unavailable');
  }
  const membership = (await client.query<{ enabled: boolean; revoked_at: Date | null; role: string; actor_alias: string; permissions: string[] }>(
    `SELECT enabled,revoked_at,role,actor_alias,permissions FROM human_tenant_memberships
      WHERE human_id=$1::uuid AND tenant_id=$2 FOR SHARE`, [match[1], tenant])).rows[0];
  if (!membership || !membership.enabled || membership.revoked_at !== null || membership.actor_alias !== alias
      || (control && membership.role !== 'operator') || !membership.permissions.includes(control ? 'control' : 'read')) {
    throw new FleetOperationError('forbidden', 'fleet human membership authority is unavailable');
  }
}

export async function loadFleetOrigin(client: DatabaseClient, row: FleetOperationRow): Promise<FleetOperationRow> {
  const queued = (await client.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM fleet_operation_events WHERE operation_id=$1 AND event='queued' ORDER BY id LIMIT 1`, [row.id])).rows[0];
  if (queued && Object.hasOwn(queued.metadata, 'actor_subject')) {
    const subject = queued.metadata.actor_subject;
    if (typeof subject !== 'string' || subject.length < 1 || subject.length > 256) {
      throw new FleetOperationError('forbidden', 'fleet operation human provenance is invalid');
    }
    row.actor_subject = subject;
  } else delete row.actor_subject;
  return row;
}

export async function assertFleetOperationAuthority(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  await loadFleetOrigin(client, row);
  await assertFleetHumanAuthority(client, row.actor_tenant, row.actor_alias, row.actor_subject);
  await assertFleetAuthority(client, row.actor_tenant, row.actor_alias, row.target);
}
