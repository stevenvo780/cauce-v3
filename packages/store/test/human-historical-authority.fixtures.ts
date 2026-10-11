import { readFile } from 'node:fs/promises';
import type { DatabaseClient, DatabasePool } from '../src/db.js';

const dependencies = ['048_ui_fleet_lifecycle.sql', '051_companies.sql', '062_authority_read_guard.sql'] as const;
const ledgers = ['schema_migrations', 'schema_migration_ledger'] as const;
const provenance = ['human_message_client_provenance', 'human_client_delegation_operations', 'human_oauth_client_delegations'];

async function migrationLedgers(client: DatabaseClient): Promise<unknown[][]> {
  const records: unknown[][] = [];
  for (const ledger of ledgers) {
    records.push((await client.query(`SELECT to_jsonb(record) AS value FROM ${ledger} record ORDER BY version`)).rows);
  }
  return records;
}

// This is a hybrid fixture, never a fully migrated database or a historical authority implementation.
export async function installHistoricalHumanAuthority(pool: DatabasePool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const ledger of ledgers) {
      const invalid = await client.query(`SELECT 1 FROM ${ledger} WHERE version > '046_human_client_provenance.sql'`);
      const cutoff = await client.query(`SELECT 1 FROM ${ledger} WHERE version = '046_human_client_provenance.sql'`);
      if (invalid.rowCount !== 0 || cutoff.rowCount !== 1) throw new Error('hybrid authority requires the exact historical provenance prefix');
    }
    const beforeLedger = await migrationLedgers(client);
    const beforeSchema = (await client.query<{ name: string; identity: string | null }>(
      'SELECT name,to_regclass(name)::oid::text AS identity FROM unnest($1::text[]) name ORDER BY name', [provenance],
    )).rows;
    if (beforeSchema.some(row => row.identity === null)) throw new Error('historical provenance tables are absent');
    const prerequisite = (await client.query<{ available: boolean }>(`SELECT
      to_regclass('companies') IS NULL AND to_regprocedure('cauce_lock_authority_read_guard()') IS NULL
      AND to_regclass('fleet_operations') IS NULL
      AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cauce_runtime' AND NOT rolcanlogin AND NOT rolsuper
        AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
      AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cauce_platform' AND NOT rolcanlogin)
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members membership JOIN pg_roles role ON role.oid=membership.member
        WHERE role.rolname='cauce_runtime') AS available`)).rows[0];
    if (!prerequisite?.available) throw new Error('canonical role or historical schema prerequisites are unavailable');
    for (const version of dependencies) {
      await client.query(await readFile(new URL(`../migrations/${version}`, import.meta.url), 'utf8'));
    }
    const afterSchema = (await client.query<{ name: string; identity: string | null }>(
      'SELECT name,to_regclass(name)::oid::text AS identity FROM unnest($1::text[]) name ORDER BY name', [provenance],
    )).rows;
    if (JSON.stringify(afterSchema) !== JSON.stringify(beforeSchema)
      || JSON.stringify(await migrationLedgers(client)) !== JSON.stringify(beforeLedger)) {
      throw new Error('hybrid authority overlay changed a provenance table or migration ledger');
    }
    const actual = (await client.query<{ schema: boolean; permissions: boolean }>(`SELECT
      to_regclass('companies') IS NOT NULL AND to_regclass('platform_admins') IS NOT NULL
      AND to_regclass('company_links') IS NOT NULL AND to_regclass('fleet_operations') IS NOT NULL
      AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='tenants' AND column_name IN ('company_id','retired_at') GROUP BY table_name HAVING count(*)=2) AS schema,
      EXISTS(SELECT 1 FROM pg_proc routine WHERE routine.oid='cauce_lock_authority_read_guard()'::regprocedure
        AND routine.prosecdef AND routine.proacl IS NOT NULL
        AND 'search_path=pg_catalog, public, pg_temp'=ANY(routine.proconfig)
        AND NOT EXISTS(SELECT 1 FROM aclexplode(routine.proacl) privilege WHERE privilege.grantee=0))
      AND has_function_privilege('cauce_runtime','cauce_lock_authority_read_guard()','EXECUTE')
      AND has_function_privilege('cauce_platform','cauce_lock_authority_read_guard()','EXECUTE') AS permissions`)).rows[0];
    if (!actual?.schema || !actual.permissions) throw new Error('hybrid authority schema or canonical function privileges differ');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
