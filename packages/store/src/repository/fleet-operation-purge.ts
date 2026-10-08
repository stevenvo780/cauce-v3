import type { FleetTarget } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { FleetOperationError, type FleetOperationRow } from './fleet-operation-contracts.js';
import { HISTORICAL_MEMBERSHIP, PURGE_CONFIGURATION, purgeDependencies, purgeParams, purgePredicate, purgeTables, sqlIdentifier } from './fleet-operation-purge-plan.js';

function targetTable(target: FleetTarget): string { return target.resource === 'agent' ? 'agents' : target.resource === 'room' ? 'rooms' : 'tenants'; }
function targetWhere(target: FleetTarget): string {
  return target.resource === 'agent' ? 'tenant_id=$1 AND alias=$2' : target.resource === 'room' ? 'tenant_id=$1 AND id=$2' : 'id=$1 AND $2::text IS NULL';
}
async function removeConfiguration(client: DatabaseClient, row: FleetOperationRow): Promise<Record<string, unknown>> {
  const archive: Record<string, unknown> = {};
  const tables = await purgeTables(client);
  for (const name of PURGE_CONFIGURATION) {
    const table = tables.find(candidate => candidate.table_name === name);
    if (!table) continue;
    const predicate = purgePredicate(table, row.target, true);
    if (!predicate) continue;
    const records = (await client.query<Record<string, unknown>>(`SELECT to_jsonb(entry) AS record FROM ${sqlIdentifier(name)} entry
      WHERE (${predicate}) FOR UPDATE`, purgeParams(row.target))).rows.map(value => value.record);
    if (!records.length) continue;
    archive[name] = records;
    await client.query(`DELETE FROM ${sqlIdentifier(name)} entry WHERE (${predicate})`, purgeParams(row.target));
  }
  return archive;
}
async function purgeAgents(client: DatabaseClient, target: FleetTarget): Promise<void> {
  if (target.resource === 'room') {
    await client.query('UPDATE agents SET primary_room_id=NULL,enabled=false WHERE tenant_id=$1 AND primary_room_id=$2', purgeParams(target));
    return;
  }
  await client.query(`UPDATE agents SET purged_at=COALESCE(purged_at,clock_timestamp()),retired_at=COALESCE(retired_at,clock_timestamp()),
    enabled=false,lifecycle_state='retired',primary_room_id=NULL,harness_id=NULL,primary_account_id=NULL,model_id=NULL,reasoning_effort=NULL,
    container_name=NULL,runtime_user=NULL,home_directory=NULL,state_directory=NULL,systemd_user=NULL,host_id=NULL,
    max_concurrent_deliveries=NULL,role_brief=NULL,role_template_slug=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND ($2::text IS NULL OR alias=$2)`, purgeParams(target));
}
async function retireAnchors(client: DatabaseClient, target: FleetTarget): Promise<void> {
  const predicate = target.resource === 'agent' ? 'entry.tenant_id=$1 AND entry.alias=$2'
    : target.resource === 'room' ? 'entry.tenant_id=$1 AND entry.room_id=$2' : 'entry.tenant_id=$1 AND $2::text IS NULL';
  await client.query(`UPDATE memberships entry SET enabled=false,retired_at=COALESCE(retired_at,clock_timestamp()),
    retired_enabled=COALESCE(retired_enabled,false) WHERE ${predicate}`, purgeParams(target));
  await client.query(`DELETE FROM memberships entry WHERE (${predicate}) AND NOT ${HISTORICAL_MEMBERSHIP}`, purgeParams(target));
}
export async function purgeRetiredTarget(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  for (const [name, evidence] of [['stop', 'stopped_verified'], ['revoke', 'revocation_verified']] as const) {
    const step = row.steps.find(value => value.name === name);
    if (row.kind !== 'purge' || step?.status !== 'succeeded' || step.evidence?.[evidence] !== true) {
      throw new FleetOperationError('conflict', 'purge requires verified runtime stop and credential revocation');
    }
  }
  const table = targetTable(row.target); const params = purgeParams(row.target);
  const target = (await client.query<{ retired_at: Date | null; enabled: boolean }>(
    `SELECT retired_at,enabled FROM ${sqlIdentifier(table)} WHERE ${targetWhere(row.target)} FOR UPDATE`, params)).rows[0];
  if (!target?.retired_at || target.enabled) throw new FleetOperationError('conflict', 'purge requires an inactive retired target');
  const dependencies = await purgeDependencies(client, row.target);
  if (dependencies.some(value => value.blocking)) throw new FleetOperationError('conflict', 'purge target has active work or control');
  await client.query("SELECT set_config('cauce.actor_tenant',$1,true),set_config('cauce.actor_alias',$2,true)", [row.actor_tenant, row.actor_alias]);
  const archive = await removeConfiguration(client, row);
  await purgeAgents(client, row.target);
  await retireAnchors(client, row.target);
  if (row.target.resource !== 'agent') {
    const historical = dependencies.some(value => value.type !== `purge.preserve.${table}` && value.type.startsWith('purge.preserve.'));
    if (!historical) await client.query(`DELETE FROM ${sqlIdentifier(table)} WHERE ${targetWhere(row.target)}`, params);
    else await client.query(`UPDATE ${sqlIdentifier(table)} SET purged_at=COALESCE(purged_at,clock_timestamp()) WHERE ${targetWhere(row.target)}`, params);
    if (row.target.resource === 'tenant') {
      await client.query(`UPDATE rooms SET purged_at=COALESCE(purged_at,clock_timestamp()),enabled=false,
        retired_at=COALESCE(retired_at,clock_timestamp()),retired_enabled=COALESCE(retired_enabled,false) WHERE tenant_id=$1`, [row.target.tenant_id]);
      await client.query('UPDATE provider_accounts SET enabled=false WHERE payer_tenant_id=$1', [row.target.tenant_id]);
      await client.query('UPDATE acl_edges SET enabled=false WHERE from_tenant=$1 OR to_tenant=$1', [row.target.tenant_id]);
    }
  }
  await client.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,$2,'step_completed',$3::jsonb)`,
    [row.id, Number(row.version) + 1, JSON.stringify({ step: 'purge_scope', purge_scope: dependencies, deleted_configuration: archive })]);
}
