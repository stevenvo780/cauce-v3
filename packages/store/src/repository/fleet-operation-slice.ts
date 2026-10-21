import { sha256Hex } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { lockFleetRevision } from './fleet-operation-authority.js';
import { FleetOperationError, type FencedFleetTarget, type FleetOperationRow } from './fleet-operation-contracts.js';
import { runtimePrincipalScopeSql } from './system-principal-scope.js';

/**
 * The configuration a prepared operation depends on: every agent it fenced or its group target reaches now, their
 * memberships, rooms, tenant, harness, provider accounts, routing ceiling and bindings, and the hosts they run on
 * before and after the operation. Columns that the operation's own steps, the provider login and the controllers write
 * (lifecycle, login enablement and identity, quota pauses, host reachability, timestamps) stay out, so that only a
 * foreign change of this slice reads as one; login enablement enters as the usability the fleet authority checks.
 */
const SLICE_SQL = `WITH identities AS (
    SELECT agent.tenant_id,agent.alias FROM agents agent WHERE agent.tenant_id=$1 AND agent.purged_at IS NULL
      AND ${runtimePrincipalScopeSql('agent.tenant_id', 'agent.alias')}
      AND ($2::text IS NULL OR agent.alias=$2)
      AND ($3::text IS NULL OR agent.primary_room_id=$3 OR EXISTS (
        SELECT 1 FROM memberships member WHERE member.tenant_id=agent.tenant_id AND member.alias=agent.alias AND member.room_id=$3))
    UNION SELECT value->>'tenant_id',value->>'alias' FROM jsonb_array_elements($4::jsonb) value),
  scoped AS (SELECT agent.* FROM agents agent JOIN identities USING (tenant_id,alias)),
  member AS (SELECT entry.* FROM memberships entry JOIN identities USING (tenant_id,alias)),
  ceiling AS (SELECT entry.* FROM alias_routing_ceiling entry JOIN identities USING (tenant_id,alias)),
  binding AS (SELECT entry.* FROM agent_account_bindings entry JOIN identities ON identities.tenant_id=entry.tenant_id AND identities.alias=entry.agent_alias),
  account_ids AS (SELECT primary_account_id AS id FROM scoped UNION SELECT account_id FROM ceiling UNION SELECT account_id FROM binding),
  room_ids AS (SELECT tenant_id,primary_room_id AS id FROM scoped UNION SELECT tenant_id,room_id FROM member UNION SELECT $1,$3::text),
  host_ids AS (SELECT host_id AS id FROM scoped UNION SELECT jsonb_array_elements_text($5::jsonb))
  SELECT jsonb_build_object(
    'agents',(SELECT jsonb_agg(to_jsonb(entry)-ARRAY['lifecycle_state','created_at','updated_at'] ORDER BY tenant_id,alias) FROM scoped entry),
    'memberships',(SELECT jsonb_agg(to_jsonb(entry)-'created_at' ORDER BY tenant_id,alias,room_id) FROM member entry),
    'ceilings',(SELECT jsonb_agg(to_jsonb(entry)-'created_at' ORDER BY tenant_id,alias,account_id) FROM ceiling entry),
    'bindings',(SELECT jsonb_agg(to_jsonb(entry)-ARRAY['created_at','updated_at'] ORDER BY tenant_id,agent_alias,account_id) FROM binding entry),
    'accounts',(SELECT jsonb_agg(to_jsonb(entry)-ARRAY['enabled','external_account_id','quota_registration_key','quota_identity_hash',
        'quota_version','canonical_account_id','paused_until','paused_reason','created_at','updated_at']
      || jsonb_build_object('usable',entry.enabled OR (entry.quota_registration_key IS NOT NULL AND entry.quota_identity_hash IS NULL)) ORDER BY id)
      FROM provider_accounts entry WHERE id IN (SELECT id FROM account_ids)),
    'harnesses',(SELECT jsonb_agg(to_jsonb(entry)-ARRAY['created_at','updated_at'] ORDER BY id)
      FROM harness_definitions entry WHERE id IN (SELECT harness_id FROM scoped)),
    'tenants',(SELECT jsonb_agg(to_jsonb(entry)-'created_at' ORDER BY id) FROM tenants entry
      WHERE id=$1 OR id IN (SELECT tenant_id FROM identities)),
    'rooms',(SELECT jsonb_agg(to_jsonb(entry)-'created_at' ORDER BY tenant_id,id) FROM rooms entry
      WHERE (tenant_id,id) IN (SELECT tenant_id,id FROM room_ids)),
    'hosts',(SELECT jsonb_agg(to_jsonb(entry)-ARRAY['version','controller_status','controller_seen_at','created_at','updated_at'] ORDER BY host_id)
      FROM fleet_hosts entry WHERE host_id IN (SELECT id FROM host_ids))) AS slice`;

/** The digest of the configuration slice of an operation's targets, sealed at preparation and compared afterwards. */
export async function fleetTargetSliceDigest(client: DatabaseClient, row: FleetOperationRow, fenced: readonly FencedFleetTarget[],
  previous: readonly Record<string, unknown>[]): Promise<string> {
  const { target } = row;
  const identities = [...fenced.map(({ tenant_id, alias }) => ({ tenant_id, alias })),
    ...(target.resource === 'agent' ? [{ tenant_id: target.tenant_id, alias: target.alias }] : [])];
  const hosts = previous.map(agent => agent.host_id).filter((host): host is string => typeof host === 'string');
  const slice = (await client.query<{ slice: unknown }>(SLICE_SQL, [target.tenant_id, target.resource === 'agent' ? target.alias : null,
    target.resource === 'room' ? target.room_id : null, JSON.stringify(identities), JSON.stringify(hosts)])).rows[0]?.slice;
  return sha256Hex(slice ?? null);
}

/**
 * Holds the configuration lock and admits a prepared operation while no write touched its targets since preparation:
 * the company revision moves with every unrelated write, so a moved revision falls back to the sealed slice digest.
 * An operation sealed without a digest keeps the exact revision comparison.
 */
export async function lockPreparedFleetRevision(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  if (row.desired_revision === null) throw new FleetOperationError('conflict', 'fleet operation has not been prepared');
  if (await lockFleetRevision(client, undefined, row.company_id) === Number(row.desired_revision)) return;
  const sealed = (await client.query<{ digest: unknown; fenced: unknown; previous: unknown }>(`SELECT metadata->'target_slice_sha256' AS digest,
    metadata->'fenced_targets' AS fenced,metadata->'previous_agents' AS previous FROM fleet_operation_events
    WHERE operation_id=$1 AND event='step_completed' AND metadata->>'step' IN ('prepare','fence') ORDER BY id LIMIT 1`, [row.id])).rows[0];
  if (typeof sealed?.digest !== 'string' || !Array.isArray(sealed.fenced) || !Array.isArray(sealed.previous)
      || sealed.digest !== await fleetTargetSliceDigest(client, row, sealed.fenced as FencedFleetTarget[], sealed.previous as Record<string, unknown>[])) {
    throw new FleetOperationError('conflict', 'configuration revision changed; preview the operation again');
  }
}
