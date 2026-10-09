import { type DatabasePool } from '@cauce/store';
import { probeSchemaContract } from './probe.js';

const migrations = ['052_runtime_roles.sql', '053_company_isolation.sql', '054_company_admins.sql'] as const;

const constraints = [
  ['tenants', 'tenants_id_company_key', 'UNIQUE (id, company_id)'],
  ['rooms', 'rooms_pkey', 'PRIMARY KEY (tenant_id, id)'],
  ['rooms', 'rooms_company_id_id_key', 'UNIQUE (company_id, id)'],
  ['rooms', 'rooms_company_fkey', 'FOREIGN KEY (tenant_id, company_id) REFERENCES tenants(id, company_id)'],
  ['messages', 'messages_room_id_tenant_id_fkey', 'FOREIGN KEY (room_id, tenant_id) REFERENCES rooms(id, tenant_id)'],
  ['console_users', 'console_users_id_company_key', 'UNIQUE (id, company_id)'],
  ['console_users', 'console_users_company_fkey', 'FOREIGN KEY (tenant_id, company_id) REFERENCES tenants(id, company_id)'],
  ['provider_accounts', 'provider_accounts_id_company_key', 'UNIQUE (id, company_id)'],
  ['provider_accounts', 'provider_accounts_company_fkey', 'FOREIGN KEY (payer_tenant_id, company_id) REFERENCES tenants(id, company_id)'],
  ['agents', 'agents_company_fkey', 'FOREIGN KEY (tenant_id, company_id) REFERENCES tenants(id, company_id)'],
  ['agents', 'agents_primary_account_company_fkey', 'FOREIGN KEY (primary_account_id, company_id) REFERENCES provider_accounts(id, company_id)'],
  ['agents', 'agents_host_company_fkey', 'FOREIGN KEY (host_id, company_id) REFERENCES fleet_hosts(host_id, company_id)'],
  ['alias_routing_ceiling', 'alias_routing_ceiling_company_fkey', 'FOREIGN KEY (tenant_id, company_id) REFERENCES tenants(id, company_id)'],
  ['alias_routing_ceiling', 'alias_routing_ceiling_account_company_fkey', 'FOREIGN KEY (account_id, company_id) REFERENCES provider_accounts(id, company_id)'],
  ['agent_account_bindings', 'agent_account_bindings_company_fkey', 'FOREIGN KEY (tenant_id, company_id) REFERENCES tenants(id, company_id)'],
  ['agent_account_bindings', 'agent_account_bindings_account_company_fkey', 'FOREIGN KEY (account_id, company_id) REFERENCES provider_accounts(id, company_id)'],
  ['quota_window_state', 'quota_window_state_company_fkey', 'FOREIGN KEY (collector_tenant, company_id) REFERENCES tenants(id, company_id)'],
  ['quota_window_state', 'quota_window_state_account_company_fkey', 'FOREIGN KEY (account_id, company_id) REFERENCES provider_accounts(id, company_id)'],
  ['console_agent_favorites', 'console_agent_favorites_company_fkey', 'FOREIGN KEY (tenant_id, company_id) REFERENCES tenants(id, company_id)'],
  ['console_agent_favorites', 'console_agent_favorites_human_company_fkey', 'FOREIGN KEY (human_id, company_id) REFERENCES console_users(id, company_id) ON DELETE CASCADE'],
  ['human_tenant_memberships', 'human_tenant_memberships_company_fkey', 'FOREIGN KEY (tenant_id, company_id) REFERENCES tenants(id, company_id) ON DELETE RESTRICT'],
  ['human_tenant_memberships', 'human_tenant_memberships_human_company_fkey', 'FOREIGN KEY (human_id, company_id) REFERENCES console_users(id, company_id) ON DELETE RESTRICT'],
  ['fleet_hosts', 'fleet_hosts_host_company_key', 'UNIQUE (host_id, company_id)'],
  ['config_revisions', 'config_revisions_scope_company', "CHECK ((scope = 'company'::text) = (company_id IS NOT NULL))"],
  ['company_admins', 'company_admins_human_id_company_id_fkey', 'FOREIGN KEY (human_id, company_id) REFERENCES console_users(id, company_id) ON DELETE RESTRICT'],
] as const;

// The platform plane, and the catalogs the runtime may lock, are written only past the statement guard of 052.
const platformWrites = [
  ...['companies', 'company_links', 'platform_admins', 'company_admins', 'platform_authority_events',
    'company_system_principals', 'company_agent_roles', 'agent_role_template_owners', 'harness_definitions', 'role_policies',
  ].map((table) => [table, `${table}_platform_write`]),
  ['audit_events', 'audit_events_platform_rewrite'],
] as const;

// Every guard, plus the triggers the backfill pauses: a disabled one silently drops a boundary.
const triggers = [
  ['tenants', 'tenants_company_admission'], ['tenants', 'tenants_company_immutable'],
  ...['rooms', 'console_users', 'agents', 'provider_accounts', 'alias_routing_ceiling', 'agent_account_bindings',
    'quota_window_state', 'console_agent_favorites', 'human_tenant_memberships', 'fleet_hosts', 'fleet_operations',
  ].flatMap((table) => [[table, `${table}_company_fill`], [table, `${table}_company_immutable`]]),
  ['config_revisions', 'config_revisions_company_fill'], ['config_revisions', 'config_revisions_append_only'],
  ...['secret_handoffs', 'blob_delivery_grants', 'agent_output_materializations', 'agent_failure_notices']
    .map((table) => [table, `${table}_company_reachable`]),
  ['quota_window_samples', 'quota_window_samples_company_guard'], ['quota_collections', 'quota_collections_company_guard'],
  ...platformWrites,
  ['companies', 'companies_owner_required'], ['company_admins', 'company_admins_owner_continuity'],
  ['console_users', 'console_users_owner_guard'], ['platform_admins', 'platform_admins_journal'],
  ['platform_authority_events', 'platform_authority_events_append_only'],
  ['agents', 'agents_role_template_company_guard'], ['agent_role_template_owners', 'agent_role_template_owners_company_guard'],
  ['agents', 'agents_host_registration'],
  ['human_tenant_memberships', 'cauce_oauth_membership_revision'], ['human_tenant_memberships', 'human_membership_preserved'],
  ['agents', 'agents_role_brief_journal'], ['agents', 'agent_runtime_key_reservation'],
  ['agents', 'agents_role_template_coherence'], ['fleet_operations', 'fleet_operations_history'],
] as const;

const definers = [
  'cauce_company_authority(uuid,text)', 'cauce_lock_owner_guard(text)',
  'cauce_lock_company_link(text,text)', 'cauce_lock_hub_star_tenant(text)',
] as const;

// Guards run as the writer: each keeps pg_temp last so a temporary table never shadows what it reads.
const guards = [
  'cauce_platform_operator()', 'cauce_fill_company()', 'cauce_fill_company_from_human()', 'cauce_company_immutable()',
  'cauce_tenants_company_admission()', 'cauce_assert_company_reachable(text,text)', 'cauce_pair_company_guard()',
  'cauce_fill_host_company()', 'cauce_register_placed_host()', 'cauce_fill_operation_company()',
  'cauce_config_revision_company()', 'cauce_quota_company_guard()', 'cauce_company_owner_continuity()',
  'cauce_console_users_owner_guard()', 'cauce_role_template_company_guard()',
] as const;

// The runtime executes the 054 resolver and every helper a guard calls while it writes.
const runtimeCalls = [
  'cauce_lock_company_link(text,text)', 'cauce_lock_hub_star_tenant(text)', 'cauce_platform_operator()',
  'cauce_assert_company_reachable(text,text)', 'cauce_config_revision_scope(jsonb)',
  'cauce_company_authority(uuid,text)', 'cauce_lock_owner_guard(text)',
] as const;

function rows(values: readonly (readonly string[])[]): string {
  return values.map((row) => `(${row.map((value) => `'${value.replaceAll("'", "''")}'`).join(',')})`).join(',');
}

/** Proves the company isolation and authority schema of 052-054 and the runtime grants it needs. */
export async function probeCompanyIsolationPath(pool: DatabasePool): Promise<void> {
  await probeSchemaContract(pool, {
    name: 'schema-054 company isolation',
    required: ['migrations_applied', 'constraints_exact', 'triggers_enabled', 'platform_writes_guarded', 'definers_exact',
      'guards_pinned', 'authority_permissions'],
    params: [migrations],
    sql: `WITH expected_constraints(relation,name,definition) AS (VALUES ${rows(constraints)}),
       expected_triggers(relation,name) AS (VALUES ${rows(triggers)}),
       platform_writes(relation,name) AS (VALUES ${rows(platformWrites)}),
       expected_definers(signature) AS (VALUES ${rows(definers.map((signature) => [signature]))}),
       expected_guards(signature) AS (VALUES ${rows(guards.map((signature) => [signature]))}),
       runtime_calls(signature) AS (VALUES ${rows(runtimeCalls.map((signature) => [signature]))})
       SELECT
         (SELECT count(*)=cardinality($1::text[]) FROM schema_migrations migration
            JOIN schema_migration_ledger ledger USING (version)
           WHERE migration.version=ANY($1::text[]) AND ledger.source_origin='applied-atomically') AS migrations_applied,
         NOT EXISTS (SELECT 1 FROM expected_constraints expected
           LEFT JOIN pg_constraint actual ON actual.conrelid=to_regclass('public.'||expected.relation)
             AND actual.conname=expected.name
           WHERE actual.oid IS NULL OR NOT actual.convalidated
             OR pg_get_constraintdef(actual.oid,true)<>expected.definition) AS constraints_exact,
         NOT EXISTS (SELECT 1 FROM expected_triggers expected
           LEFT JOIN pg_trigger actual ON actual.tgrelid=to_regclass('public.'||expected.relation)
             AND actual.tgname=expected.name AND NOT actual.tgisinternal
           WHERE actual.oid IS NULL OR actual.tgenabled<>'O') AS triggers_enabled,
         NOT EXISTS (SELECT 1 FROM platform_writes expected
           LEFT JOIN pg_trigger actual ON actual.tgrelid=to_regclass('public.'||expected.relation)
             AND actual.tgname=expected.name AND NOT actual.tgisinternal
           WHERE actual.oid IS NULL
             OR actual.tgfoid IS DISTINCT FROM to_regprocedure('public.cauce_platform_write_guard()')) AS platform_writes_guarded,
         NOT EXISTS (SELECT 1 FROM expected_definers expected
           LEFT JOIN pg_proc actual ON actual.oid=to_regprocedure('public.'||expected.signature)
           WHERE actual.oid IS NULL OR NOT actual.prosecdef OR actual.proacl IS NULL
             OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
             OR EXISTS (SELECT 1 FROM aclexplode(actual.proacl) privilege WHERE privilege.grantee=0)) AS definers_exact,
         NOT EXISTS (SELECT 1 FROM expected_guards expected
           LEFT JOIN pg_proc actual ON actual.oid=to_regprocedure('public.'||expected.signature)
           WHERE actual.oid IS NULL OR actual.prosecdef
             OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']) AS guards_pinned,
         NOT EXISTS (SELECT 1 FROM runtime_calls expected
           WHERE to_regprocedure('public.'||expected.signature) IS NULL
             OR NOT has_function_privilege(current_user,to_regprocedure('public.'||expected.signature),'EXECUTE'))
         AND has_table_privilege(current_user,'public.company_admins','SELECT')
           AND has_table_privilege(current_user,'public.company_system_principals','SELECT')
           AND has_table_privilege(current_user,'public.company_agent_roles','SELECT')
           AND has_table_privilege(current_user,'public.agent_role_template_owners','SELECT')
           AND has_table_privilege(current_user,'public.platform_authority_events','SELECT')
           AS authority_permissions`,
  });
}
