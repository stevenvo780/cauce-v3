import { sha256Hex } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { lockFleetRevision } from './fleet-operation-authority.js';
import { FleetOperationError, type FencedFleetTarget, type FleetOperationRow } from './fleet-operation-contracts.js';
import { preparedState } from './fleet-operation-state.js';
import { runtimePrincipalScopeSql } from './system-principal-scope.js';

/**
 * The configuration a prepared operation depends on: every agent it fenced or its group target reaches now, their
 * memberships and the role policies admission grants through them, their rooms (all of a tenant target's), tenant,
 * harness, provider accounts, routing ceiling and bindings, and the hosts they run on before and after the operation.
 * Columns that the operation's own steps, the provider login and the controllers write (lifecycle, login enablement,
 * the write-once quota identity hash, quota pauses, host reachability, update stamps) stay out, so that only a foreign
 * change of this slice reads as one. Creation stamps stay in: a row deleted and recreated is a different row. Login
 * enablement enters as the usability the fleet authority checks, and an account sealed unverified keeps its sealed
 * identity once a verified login binds it ($7), since that binding never replaces a verified identity.
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
  room_ids AS (SELECT tenant_id,primary_room_id AS id FROM scoped UNION SELECT tenant_id,room_id FROM member UNION SELECT $1,$3::text
    UNION SELECT tenant_id,id FROM rooms WHERE $6::text='tenant' AND tenant_id=$1),
  host_ids AS (SELECT host_id AS id FROM scoped UNION SELECT jsonb_array_elements_text($5::jsonb))
  SELECT jsonb_build_object(
    'agents',(SELECT jsonb_agg(to_jsonb(entry)-ARRAY['lifecycle_state','updated_at'] ORDER BY tenant_id,alias) FROM scoped entry),
    'memberships',(SELECT jsonb_agg(to_jsonb(entry) ORDER BY tenant_id,alias,room_id) FROM member entry),
    'policies',(SELECT jsonb_agg(to_jsonb(entry) ORDER BY role) FROM role_policies entry WHERE role IN (SELECT role FROM member)),
    'ceilings',(SELECT jsonb_agg(to_jsonb(entry) ORDER BY tenant_id,alias,account_id) FROM ceiling entry),
    'bindings',(SELECT jsonb_agg(to_jsonb(entry)-'updated_at' ORDER BY tenant_id,agent_alias,account_id) FROM binding entry),
    'accounts',(SELECT jsonb_agg(to_jsonb(entry)-ARRAY['enabled','external_account_id','quota_registration_key','quota_identity_hash',
        'quota_version','canonical_account_id','paused_until','paused_reason','updated_at']
      || jsonb_build_object('usable',entry.enabled OR (entry.quota_registration_key IS NOT NULL AND entry.quota_identity_hash IS NULL),
        'identity',CASE WHEN entry.external_account_id NOT LIKE 'unverified:%' AND ($7::jsonb->>entry.id) LIKE 'unverified:%'
          THEN $7::jsonb->>entry.id ELSE entry.external_account_id END) ORDER BY id)
      FROM provider_accounts entry WHERE id IN (SELECT id FROM account_ids)),
    'harnesses',(SELECT jsonb_agg(to_jsonb(entry)-'updated_at' ORDER BY id)
      FROM harness_definitions entry WHERE id IN (SELECT harness_id FROM scoped)),
    'tenants',(SELECT jsonb_agg(to_jsonb(entry) ORDER BY id) FROM tenants entry
      WHERE id=$1 OR id IN (SELECT tenant_id FROM identities)),
    'rooms',(SELECT jsonb_agg(to_jsonb(entry) ORDER BY tenant_id,id) FROM rooms entry
      WHERE (tenant_id,id) IN (SELECT tenant_id,id FROM room_ids)),
    'hosts',(SELECT jsonb_agg(to_jsonb(entry)-ARRAY['version','controller_status','controller_seen_at','updated_at'] ORDER BY host_id)
      FROM fleet_hosts entry WHERE host_id IN (SELECT id FROM host_ids))) AS slice`;

interface SliceSeal { target_slice_sha256: string; account_identities: Record<string, string> }

async function sliceSeal(client: DatabaseClient, row: FleetOperationRow, fenced: readonly FencedFleetTarget[],
  previous: readonly Record<string, unknown>[], identities: Record<string, string> = {}): Promise<SliceSeal> {
  const { target } = row;
  const agents = [...fenced.map(({ tenant_id, alias }) => ({ tenant_id, alias })),
    ...(target.resource === 'agent' ? [{ tenant_id: target.tenant_id, alias: target.alias }] : [])];
  const hosts = previous.map(agent => agent.host_id).filter((host): host is string => typeof host === 'string');
  const slice = (await client.query<{ slice: { accounts: { id: string; identity: string }[] | null } | null }>(SLICE_SQL, [target.tenant_id,
    target.resource === 'agent' ? target.alias : null, target.resource === 'room' ? target.room_id : null, JSON.stringify(agents),
    JSON.stringify(hosts), target.resource, JSON.stringify(identities)])).rows[0]?.slice ?? null;
  return { target_slice_sha256: sha256Hex(slice),
    account_identities: Object.fromEntries((slice?.accounts ?? []).map(account => [account.id, account.identity])) };
}

/**
 * Seals the slice as it stands after a step that passed the check, so that the operation's own effects (a purge
 * retiring its rows, a binding enabling its account) never read later as a foreign change.
 */
export async function sealFleetTargetSlice(client: DatabaseClient, row: FleetOperationRow,
  fenced?: readonly FencedFleetTarget[], previous?: readonly Record<string, unknown>[]): Promise<SliceSeal> {
  const prepared = fenced === undefined || previous === undefined ? await preparedState(client, row.id) : undefined;
  return sliceSeal(client, row, fenced ?? prepared?.fenced_targets ?? [], previous ?? prepared?.previous_agents ?? []);
}

/**
 * Holds the configuration lock and admits a prepared operation while no write touched its targets since its last
 * seal: the company revision moves with every unrelated write, so a moved revision falls back to the sealed slice.
 * An operation never sealed keeps the exact revision comparison.
 */
export async function lockPreparedFleetRevision(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  if (row.desired_revision === null) throw new FleetOperationError('conflict', 'fleet operation has not been prepared');
  if (await lockFleetRevision(client, undefined, row.company_id) === Number(row.desired_revision)) return;
  const sealed = (await client.query<{ digest: unknown; identities: unknown }>(`SELECT metadata->'target_slice_sha256' AS digest,
    metadata->'account_identities' AS identities FROM fleet_operation_events
    WHERE operation_id=$1 AND metadata ? 'target_slice_sha256' ORDER BY id DESC LIMIT 1`, [row.id])).rows[0];
  const identities = sealed?.identities;
  if (typeof sealed?.digest !== 'string' || identities === null || typeof identities !== 'object' || Array.isArray(identities)) {
    throw new FleetOperationError('conflict', 'configuration revision changed; preview the operation again');
  }
  const prepared = await preparedState(client, row.id);
  const current = await sliceSeal(client, row, prepared.fenced_targets, prepared.previous_agents, identities as Record<string, string>);
  if (current.target_slice_sha256 !== sealed.digest) {
    throw new FleetOperationError('conflict', 'configuration revision changed; preview the operation again');
  }
}
