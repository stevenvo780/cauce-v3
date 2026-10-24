import type pg from 'pg';

export const migrationLockModes = ['SHARE', 'SHARE ROW EXCLUSIVE', 'EXCLUSIVE', 'ACCESS EXCLUSIVE'] as const;
export type MigrationLockMode = typeof migrationLockModes[number];

export interface MigrationTableLock {
  table: string;
  mode: MigrationLockMode;
}

export const defaultMigrationLockTimeoutMs = 5_000;

/**
 * The order the runner takes every table lock of the pending migrations in, before the first of them
 * runs. tenants goes first, as in 051-054. connection_leases and deliveries go right before messages
 * because the gateway readiness probe and the dispatcher metrics lock them first in one statement:
 * a reader holding one of them never waits for a table the runner already holds.
 */
export const migrationLockOrder: readonly string[] = [
  'tenants', 'agent_account_bindings', 'agents', 'alias_routing_ceiling', 'terminal_sessions', 'audit_events', 'config_revisions',
  'console_agent_favorites', 'console_users', 'fleet_hosts', 'fleet_host_enrollments', 'fleet_operations', 'human_tenant_memberships',
  'memberships', 'connection_leases', 'deliveries', 'messages', 'provider_accounts', 'quota_window_state',
  'quota_provider_reports', 'quota_window_samples', 'rooms', 'agent_failure_notices', 'agent_output_materializations',
  'blob_delivery_grants', 'companies', 'company_links', 'platform_admins', 'quota_collections', 'secret_handoffs',
  'harness_definitions', 'role_policies', 'agent_role_templates', 'egress_destinations', 'company_admins',
  'company_system_principals', 'agent_chain_policies', 'agent_context_versions', 'agent_quota_operations', 'quota_environments',
];

const AE = 'ACCESS EXCLUSIVE';
const SRE = 'SHARE ROW EXCLUSIVE';

/**
 * For every migration from 052 on, the strongest lock of SHARE or above it takes on each table that
 * exists before it runs (an index counts for its table). Weaker modes never conflict with live traffic.
 * migration-locks-postgres.test.ts measures each migration in pg_locks and requires this exact map.
 */
export const migrationLockFootprints: Readonly<Record<string, Readonly<Record<string, MigrationLockMode>>>> = {
  '052_runtime_roles.sql': { tenants: AE, audit_events: SRE, harness_definitions: SRE, role_policies: SRE },
  '053_company_isolation.sql': {
    tenants: AE, agent_account_bindings: AE, agents: AE, alias_routing_ceiling: AE, audit_events: AE,
    config_revisions: AE, console_agent_favorites: AE, console_users: AE, fleet_hosts: AE, fleet_operations: AE,
    human_tenant_memberships: AE, memberships: AE, messages: AE, provider_accounts: AE, quota_window_state: AE,
    rooms: AE, agent_failure_notices: SRE, agent_output_materializations: SRE, blob_delivery_grants: SRE,
    companies: SRE, company_links: SRE, platform_admins: SRE, quota_collections: SRE, quota_window_samples: SRE,
    secret_handoffs: SRE,
  },
  '054_company_admins.sql': {
    tenants: SRE, agent_role_templates: SRE, agents: SRE, companies: SRE, company_links: SRE, console_users: SRE,
    egress_destinations: SRE, platform_admins: SRE, rooms: SRE, human_tenant_memberships: 'SHARE',
    memberships: 'SHARE', role_policies: 'SHARE',
  },
  '055_company_registration.sql': { companies: SRE, company_admins: AE, console_users: SRE },
  '056_company_office.sql': { companies: SRE, console_users: SRE },
  '057_quota_environments.sql': {
    companies: SRE, console_users: SRE, fleet_hosts: SRE, provider_accounts: AE, quota_provider_reports: AE,
    quota_window_samples: AE, quota_window_state: AE,
  },
  '058_context_versions.sql': { agents: SRE, companies: SRE, console_users: SRE, deliveries: AE },
  '059_host_enrollment.sql': { companies: SRE, console_users: SRE, fleet_hosts: SRE },
  '060_space_backups.sql': { agents: SRE, companies: SRE, console_users: SRE, fleet_hosts: SRE },
  '061_people_admin_history.sql': {},
  '062_authority_read_guard.sql': {},
  '063_company_registration_director.sql': {
    agents: SRE, company_system_principals: AE, connection_leases: SRE, deliveries: SRE, memberships: SRE,
  },
  '064_company_context_anchor.sql': {},
  '065_runtime_grants_replay.sql': {},
  '066_runtime_hardening.sql': { agent_chain_policies: SRE },
  '067_context_history_immutable.sql': { agent_context_versions: SRE },
  '069_diagnostic_frontier_indexes.sql': { audit_events: 'SHARE', messages: 'SHARE', terminal_sessions: 'SHARE' },
  '070_agent_quota_operations.sql': { agents: SRE, companies: SRE, console_users: SRE, fleet_hosts: SRE, tenants: SRE },
  '073_harness_definitions_seed.sql': {},
  '077_agent_quota_expiry.sql': { agent_quota_operations: AE },
  '078_authority_lock_scope.sql': { platform_admins: SRE },
  '079_host_enrollment_compatibility.sql': { fleet_host_enrollments: AE },
  '080_agent_alias_immutable.sql': { agents: SRE },
  '081_membresia_rol_derivado.sql': { console_users: SRE, human_tenant_memberships: AE },
  '082_company_purge.sql': {},
  '083_quota_providers_muse_agy.sql': { quota_environments: AE },
  '084_agent_extensions.sql': { agents: AE, fleet_hosts: AE },
  '085_provider_accounts_company_identity.sql': { provider_accounts: AE },
  '086_runtime_lease_identity.sql': { agents: AE },
};

/** The first migration with a footprint; every bundled migration from it on must have one. */
export const firstFootprintMigration = '052_runtime_roles.sql';

/** The strongest lock each table needs across the given migrations, in migrationLockOrder. */
export function migrationTableLocks(versions: readonly string[]): MigrationTableLock[] {
  const strongest = new Map<string, number>();
  for (const version of versions) {
    for (const [table, mode] of Object.entries(migrationLockFootprints[version] ?? {})) {
      strongest.set(table, Math.max(strongest.get(table) ?? -1, migrationLockModes.indexOf(mode)));
    }
  }
  const unordered = [...strongest.keys()].filter((table) => !migrationLockOrder.includes(table));
  if (unordered.length > 0) throw new Error(`migration lock order misses ${unordered.join(',')}`);
  return migrationLockOrder.flatMap((table) => {
    const rank = strongest.get(table);
    const mode = rank === undefined ? undefined : migrationLockModes[rank];
    return mode === undefined ? [] : [{ table, mode }];
  });
}

const preLockAttempts = 3;

/** A dead client would otherwise leave its backend waiting, every lock held, until the wait ends. */
export async function boundMigrationWaits(client: pg.PoolClient, lockTimeoutMs: number): Promise<void> {
  await client.query(
    `SELECT set_config('lock_timeout',$1,true),
            (SELECT set_config(name,'1000ms',true) FROM pg_settings WHERE name='client_connection_check_interval')`,
    [`${String(lockTimeoutMs)}ms`],
  );
}

/**
 * Takes the locks of every pending migration on the tables that already exist before the first one runs:
 * no migration then waits for a lock while holding the exclusive ones of an earlier migration, the wait
 * that deadlocked with live readers. As in 053, one statement takes them all, so statement_timeout bounds
 * how long the first ones stay held. Nothing is applied yet: a deadlock rolls back to the savepoint and
 * tries again, a timeout fails at once.
 */
export async function lockMigrationTables(
  client: pg.PoolClient, versions: readonly string[], lockTimeoutMs: number,
): Promise<void> {
  const wanted = migrationTableLocks(versions);
  const existing = new Set((await client.query<{ name: string }>(
    `SELECT relname AS name FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND relname=ANY($1::text[])`,
    [wanted.map((lock) => lock.table)],
  )).rows.map((row) => row.name));
  const statements = wanted.filter((lock) => existing.has(lock.table)).map((lock) => {
    if (!/^[a-z_][a-z0-9_]*$/u.test(lock.table)) throw new Error(`invalid table in migration lock plan: ${lock.table}`);
    return `LOCK TABLE public.${lock.table} IN ${lock.mode} MODE;`;
  });
  if (statements.length === 0) return;
  const previous = (await client.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value")).rows[0]?.value ?? '0';
  for (let attempt = 1; ; attempt += 1) {
    await client.query('SAVEPOINT cauce_migration_prelock');
    try {
      await client.query("SELECT set_config('statement_timeout',$1,true)", [`${String(lockTimeoutMs + 1_000)}ms`]);
      await client.query(`DO $prelock$ BEGIN\n${statements.join('\n')}\nEND $prelock$`);
      await client.query("SELECT set_config('statement_timeout',$1,true)", [previous]);
      await client.query('RELEASE SAVEPOINT cauce_migration_prelock');
      return;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT cauce_migration_prelock');
      const state = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (state !== '40P01' || attempt >= preLockAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt + Math.floor(Math.random() * 100)));
    }
  }
}

export function migrationLockTimeoutMs(value: string | undefined): number {
  if (value === undefined || value === '') return defaultMigrationLockTimeoutMs;
  const parsed = /^[1-9][0-9]*$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > 60_000) {
    throw new RangeError('CAUCE_MIGRATION_LOCK_TIMEOUT_MS must be an integer between 1 and 60000');
  }
  return parsed;
}
