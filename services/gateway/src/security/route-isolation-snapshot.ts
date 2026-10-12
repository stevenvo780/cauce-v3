import { createHash } from 'node:crypto';
import type { DatabasePool } from '@cauce/store';
import type { IsolationCompany } from './route-isolation-fixtures.js';

interface ForeignKey { source: string; target: string; columns: string[]; references: string[] }
interface Row { table: string; value: string; fields: Record<string, string | null> }
interface Schema { tables: string[]; keys: ForeignKey[] }
interface CompanyScope { company: string; tenants: Set<string>; humans: Set<string>; hosts: Set<string> }
export interface CompanySnapshot {
  count: number; sha256: string; tables: Record<string, { count: number; sha256: string }>;
}
const schemas = new WeakMap<DatabasePool, Promise<Schema>>();
const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

async function schema(pool: DatabasePool): Promise<Schema> {
  const tables = (await pool.query<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map(row => row.name);
  const keys = (await pool.query<ForeignKey>(`SELECT source.relname AS source,target.relname AS target,
    ARRAY(SELECT attr.attname::text FROM unnest(fk.conkey) WITH ORDINALITY AS key(attnum,position)
      JOIN pg_attribute attr ON attr.attrelid=fk.conrelid AND attr.attnum=key.attnum ORDER BY key.position) AS columns,
    ARRAY(SELECT attr.attname::text FROM unnest(fk.confkey) WITH ORDINALITY AS key(attnum,position)
      JOIN pg_attribute attr ON attr.attrelid=fk.confrelid AND attr.attnum=key.attnum ORDER BY key.position) AS references
    FROM pg_constraint fk JOIN pg_class source ON source.oid=fk.conrelid JOIN pg_namespace source_schema ON source_schema.oid=source.relnamespace
    JOIN pg_class target ON target.oid=fk.confrelid JOIN pg_namespace target_schema ON target_schema.oid=target.relnamespace
    WHERE fk.contype='f' AND source_schema.nspname='public' AND target_schema.nspname='public' ORDER BY source.relname,fk.conname`)).rows;
  if (tables.length === 0) throw new Error('company snapshot requires the migrated public schema');
  return { tables, keys };
}

function companyScope(rows: Row[], company: IsolationCompany): CompanyScope {
  const identifiers = (table: string, column: string): Set<string> => new Set(rows
    .filter(row => row.table === table && row.fields.company_id === company.company)
    .map(row => row.fields[column]).filter((value): value is string => value !== undefined && value !== null));
  return { company: company.company, tenants: identifiers('tenants', 'id'),
    humans: identifiers('console_users', 'id'), hosts: identifiers('fleet_hosts', 'host_id') };
}

function ownership(row: Row, company: CompanyScope): boolean | undefined {
  if (row.table === 'companies' && row.fields.id === company.company) return true;
  if (row.fields.company_id !== undefined && row.fields.company_id !== null) return row.fields.company_id === company.company;
  for (const column of ['owner_tenant_id', 'tenant_id', 'actor_tenant', 'payer_tenant_id', 'collector_tenant', 'recipient_tenant']) {
    const value = row.fields[column];
    if (value !== undefined && value !== null) return company.tenants.has(value);
  }
  return Object.entries(row.fields).some(([column, value]) =>
    (value !== null && ['from_tenant', 'to_tenant'].includes(column) && company.tenants.has(value))
    || (value !== null && /(?:^|_)(?:human_id|requested_by|invited_by)$/u.test(column) && company.humans.has(value))
    || (value !== null && /(?:^|_)(?:host_id|executor_host)$/u.test(column) && company.hosts.has(value))
    || (['source_node', 'target_node'].includes(column) && [...company.tenants].some(tenant => value?.startsWith(`${tenant}:`)))) ? true : undefined;
}

function reference(row: Row, columns: readonly string[]): string | undefined {
  const values = columns.map(column => row.fields[column]);
  return values.some(value => value === null || value === undefined) ? undefined : JSON.stringify(values);
}

export async function snapshotCompany(pool: DatabasePool, company: IsolationCompany): Promise<CompanySnapshot> {
  let pending = schemas.get(pool);
  if (pending === undefined) { pending = schema(pool); schemas.set(pool, pending); }
  const definition = await pending;
  // Text fields preserve bigint values; JSONB text preserves every stored column for the hash.
  const query = definition.tables.map(table => `SELECT '${table.replaceAll("'", "''")}'::text AS table,
    to_jsonb(record)::text AS value,(SELECT jsonb_object_agg(key,value) FROM jsonb_each_text(to_jsonb(record))) AS fields
    FROM public.${quote(table)} record`).join(' UNION ALL ');
  const rows = (await pool.query<Row>(query)).rows;
  const scope = companyScope(rows, company);
  const scopes = new Map(rows.map(row => [row, ownership(row, scope)]));
  const selected = new Set(rows.filter(row => scopes.get(row) === true));
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of definition.keys) {
      const targets = new Set([...selected].filter(row => row.table === key.target)
        .map(row => reference(row, key.references)).filter(value => value !== undefined));
      for (const row of rows) {
        if (row.table !== key.source || selected.has(row) || scopes.get(row) === false) continue;
        const identity = reference(row, key.columns);
        if (identity !== undefined && targets.has(identity)) { selected.add(row); changed = true; }
      }
    }
    // Chain journals deliberately omit FKs; their message/delivery references still belong to the snapshot.
    const ids = new Map<string, Set<string>>();
    for (const row of selected) {
      if (row.fields.id === undefined || row.fields.id === null) continue;
      const values = ids.get(row.table) ?? new Set<string>(); values.add(row.fields.id); ids.set(row.table, values);
    }
    for (const row of rows) {
      if (selected.has(row) || scopes.get(row) === false) continue;
      const related = Object.entries(row.fields).some(([column, value]) => {
        if (value === null) return false;
        if (/(?:^|_)message_id$/u.test(column)) return ids.get('messages')?.has(value);
        if (/(?:^|_)delivery_id$/u.test(column)) return ids.get('deliveries')?.has(value);
        if (/(?:^|_)environment_id$/u.test(column)) return ids.get('quota_environments')?.has(value);
        if (/(?:^|_)operation_id$/u.test(column)) return ['fleet_operations', 'quota_environment_operations']
          .some(table => ids.get(table)?.has(value) === true);
        return false;
      });
      if (related) { selected.add(row); changed = true; }
    }
  }
  const tables: CompanySnapshot['tables'] = {};
  for (const table of definition.tables) {
    const values = [...selected].filter(row => row.table === table).map(row => row.value).sort();
    tables[table] = { count: values.length, sha256: digest(JSON.stringify(values)) };
  }
  return { count: selected.size, sha256: digest(JSON.stringify(tables)), tables };
}
