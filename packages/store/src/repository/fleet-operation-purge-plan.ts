import type { FleetTarget } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import type { ConfigurationDependency } from '../configuration/contracts.js';

export const PURGE_CONFIGURATION = ['agent_profile_runtime_adoptions', 'agent_profile_runtime_expectations', 'agent_profiles',
  'agent_account_bindings', 'alias_routing_ceiling', 'egress_destinations', 'agent_sealing_keys', 'agent_appearances', 'console_agent_favorites'];
const AGENT_PAIRS = [['tenant_id', 'alias'], ['tenant_id', 'agent_alias'], ['tenant_id', 'actor_alias'],
  ['actor_tenant', 'actor_alias'], ['recipient_tenant', 'recipient_alias'], ['source_tenant', 'source_alias'],
  ['target_tenant', 'target_alias'], ['parent_tenant', 'parent_alias'], ['child_tenant', 'child_alias'],
  ['collector_tenant', 'collector_alias'], ['from_tenant', 'from_alias'], ['to_tenant', 'to_alias'],
  ['tenant_id', 'asked_by_alias'], ['tenant_id', 'bridge_alias'], ['tenant_id', 'created_by'],
  ['source_tenant_id', 'source_alias'], ['target_tenant_id', 'target_alias']];
export interface PurgeTable { table_name: string; columns: string[]; }
export function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error('invalid purge identifier');
  return `"${value}"`;
}
export function purgeParams(target: FleetTarget): (string | null)[] {
  return [target.tenant_id, target.resource === 'agent' ? target.alias : target.resource === 'room' ? target.room_id : null];
}
export function purgePredicate(table: PurgeTable, target: FleetTarget, own = false): string | undefined {
  const columns = new Set(table.columns);
  if (target.resource === 'agent') {
    const pairs = own ? [['tenant_id', table.table_name === 'agent_account_bindings' ? 'agent_alias' : 'alias']] : AGENT_PAIRS;
    const matches = pairs.filter(([tenant, alias]) => tenant !== undefined && alias !== undefined && columns.has(tenant) && columns.has(alias));
    return matches.length ? matches.map(([tenant, alias]) => `(entry.${sqlIdentifier(tenant ?? '')}=$1 AND entry.${sqlIdentifier(alias ?? '')}=$2)`).join(' OR ') : undefined;
  }
  if (target.resource === 'room') {
    if (own && table.table_name !== 'memberships') return undefined;
    const fields = table.table_name === 'rooms' ? ['id'] : table.columns.filter(column => /(?:^|_)room_id$/u.test(column));
    return fields.length ? fields.map(column => `entry.${sqlIdentifier(column)}=$2${columns.has('tenant_id') ? ' AND entry.tenant_id=$1' : ''}`).join(' OR ') : undefined;
  }
  if (table.table_name === 'tenants') return 'entry.id=$1';
  const fields = own ? (columns.has('tenant_id') ? ['tenant_id'] : [])
    : table.columns.filter(column => /(?:^|_)tenant(?:_id)?$/u.test(column));
  return fields.length ? `(${fields.map(column => `entry.${sqlIdentifier(column)}=$1`).join(' OR ')}) AND $2::text IS NULL` : undefined;
}
export async function purgeTables(client: DatabaseClient): Promise<PurgeTable[]> {
  return (await client.query<PurgeTable>(`SELECT source.relname AS table_name,array_agg(attribute.attname::text ORDER BY attribute.attnum) AS columns
    FROM pg_class source JOIN pg_namespace namespace ON namespace.oid=source.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid=source.oid AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE namespace.nspname=current_schema() AND source.relkind IN ('r','p') GROUP BY source.relname ORDER BY source.relname`)).rows;
}
export const HISTORICAL_MEMBERSHIP = `EXISTS(SELECT 1 FROM messages message WHERE message.tenant_id=entry.tenant_id
  AND message.room_id=entry.room_id AND message.actor_alias=entry.alias)`;
export function purgeDependency(target: FleetTarget, table: string, action: 'delete' | 'preserve' | 'blocked', count: string): ConfigurationDependency {
  return { type: `purge.${action}.${table}`, identity: { tenant_id: target.tenant_id,
    ...(target.resource === 'agent' ? { alias: target.alias } : target.resource === 'room' ? { room_id: target.room_id } : {}),
    kind: `${count} rows` }, blocking: action === 'blocked' };
}
async function countRows(client: DatabaseClient, target: FleetTarget, table: string, predicate: string): Promise<string> {
  return (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${sqlIdentifier(table)} entry WHERE (${predicate})
    AND $1::text IS NOT NULL AND ($2::text IS NULL OR $2::text IS NOT NULL)`,
    purgeParams(target))).rows[0]?.count ?? '0';
}
function runtimePredicate(target: FleetTarget): string {
  if (target.resource === 'agent') return 'entry.tenant_id=$1 AND entry.alias=$2';
  if (target.resource === 'tenant') return 'entry.tenant_id=$1 AND $2::text IS NULL';
  return `entry.tenant_id=$1 AND EXISTS(SELECT 1 FROM memberships member
    WHERE member.tenant_id=entry.tenant_id AND member.alias=entry.alias AND member.room_id=$2)`;
}
export async function purgeDependencies(client: DatabaseClient, target: FleetTarget): Promise<ConfigurationDependency[]> {
  const dependencies: ConfigurationDependency[] = [];
  for (const table of await purgeTables(client)) {
    const removable = PURGE_CONFIGURATION.includes(table.table_name) && target.resource !== 'room';
    const predicate = purgePredicate(table, target, removable);
    if (!predicate) continue;
    if (table.table_name === 'memberships') {
      for (const [action, history] of [['preserve', true], ['delete', false]] as const) {
        const count = await countRows(client, target, table.table_name, `(${predicate}) AND ${history ? '' : 'NOT '}${HISTORICAL_MEMBERSHIP}`);
        if (count !== '0') dependencies.push(purgeDependency(target, table.table_name, action, count));
      }
    } else {
      const count = await countRows(client, target, table.table_name, predicate);
      if (count !== '0') dependencies.push(purgeDependency(target, table.table_name, removable ? 'delete' : 'preserve', count));
    }
  }
  const messageScope = target.resource === 'agent' ? '(entry.recipient_tenant=$1 AND entry.recipient_alias=$2) OR (message.tenant_id=$1 AND message.actor_alias=$2)'
    : target.resource === 'tenant' ? '(entry.recipient_tenant=$1 OR message.tenant_id=$1) AND $2::text IS NULL' : 'message.tenant_id=$1 AND message.room_id=$2';
  const work = (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM deliveries entry JOIN messages message ON message.id=entry.message_id
    WHERE (${messageScope}) AND entry.status IN ('pending','retry','leased','accepted','started')`, purgeParams(target))).rows[0]?.count ?? '0';
  if (work !== '0') dependencies.push(purgeDependency(target, 'deliveries', 'blocked', work));
  for (const [table, condition] of [['connection_leases', 'entry.lease_until>clock_timestamp()'],
    ['terminal_sessions', 'entry.closed_at IS NULL AND entry.revoked_at IS NULL AND entry.expires_at>clock_timestamp()'],
    ['terminal_control_holds', 'entry.released_at IS NULL AND entry.expires_at>clock_timestamp()']]) {
    if (!table || !condition) throw new Error('invalid purge blocker');
    const count = await countRows(client, target, table, `${runtimePredicate(target)} AND ${condition}`);
    if (count !== '0') dependencies.push(purgeDependency(target, table, 'blocked', count));
  }
  return dependencies;
}
