SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_053);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE agent_account_bindings,agents,alias_routing_ceiling,audit_events,config_revisions,console_agent_favorites,
  console_users,fleet_hosts,fleet_operations,human_tenant_memberships,memberships,messages,provider_accounts,
  quota_window_state,rooms IN ACCESS EXCLUSIVE MODE;
LOCK TABLE agent_failure_notices,agent_output_materializations,blob_delivery_grants,companies,company_links,
  platform_admins,quota_collections,quota_window_samples,secret_handoffs IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>'053_company_isolation.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 053 while a later migration is present';
  END IF;
  IF (SELECT count(*) FROM companies)>1 OR EXISTS (SELECT 1 FROM rooms GROUP BY id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'rollback preserves company isolation; several companies or repeated room ids cannot be merged';
  END IF;
END;
$$;

DROP TRIGGER tenants_company_admission ON tenants;
DROP TRIGGER tenants_company_immutable ON tenants;
DROP TRIGGER rooms_company_fill ON rooms;
DROP TRIGGER rooms_company_immutable ON rooms;
DROP TRIGGER console_users_company_fill ON console_users;
DROP TRIGGER console_users_company_immutable ON console_users;
DROP TRIGGER agents_company_fill ON agents;
DROP TRIGGER agents_company_immutable ON agents;
DROP TRIGGER provider_accounts_company_fill ON provider_accounts;
DROP TRIGGER provider_accounts_company_immutable ON provider_accounts;
DROP TRIGGER alias_routing_ceiling_company_fill ON alias_routing_ceiling;
DROP TRIGGER alias_routing_ceiling_company_immutable ON alias_routing_ceiling;
DROP TRIGGER agent_account_bindings_company_fill ON agent_account_bindings;
DROP TRIGGER agent_account_bindings_company_immutable ON agent_account_bindings;
DROP TRIGGER quota_window_state_company_fill ON quota_window_state;
DROP TRIGGER quota_window_state_company_immutable ON quota_window_state;
DROP TRIGGER console_agent_favorites_company_fill ON console_agent_favorites;
DROP TRIGGER console_agent_favorites_company_immutable ON console_agent_favorites;
DROP TRIGGER human_tenant_memberships_company_fill ON human_tenant_memberships;
DROP TRIGGER human_tenant_memberships_company_immutable ON human_tenant_memberships;
DROP TRIGGER fleet_hosts_company_fill ON fleet_hosts;
DROP TRIGGER fleet_hosts_company_immutable ON fleet_hosts;
DROP TRIGGER agents_host_registration ON agents;
DROP TRIGGER fleet_operations_company_fill ON fleet_operations;
DROP TRIGGER fleet_operations_company_immutable ON fleet_operations;
DROP TRIGGER config_revisions_company_fill ON config_revisions;
DROP TRIGGER config_revisions_append_only ON config_revisions;
DROP TRIGGER secret_handoffs_company_reachable ON secret_handoffs;
DROP TRIGGER blob_delivery_grants_company_reachable ON blob_delivery_grants;
DROP TRIGGER agent_output_materializations_company_reachable ON agent_output_materializations;
DROP TRIGGER agent_failure_notices_company_reachable ON agent_failure_notices;
DROP TRIGGER quota_window_samples_company_guard ON quota_window_samples;
DROP TRIGGER quota_collections_company_guard ON quota_collections;

ALTER TABLE agents DROP CONSTRAINT agents_host_company_fkey,DROP CONSTRAINT agents_primary_account_company_fkey,
  DROP CONSTRAINT agents_company_fkey,DROP COLUMN company_id;
ALTER TABLE alias_routing_ceiling DROP CONSTRAINT alias_routing_ceiling_account_company_fkey,
  DROP CONSTRAINT alias_routing_ceiling_company_fkey,DROP COLUMN company_id;
ALTER TABLE agent_account_bindings DROP CONSTRAINT agent_account_bindings_account_company_fkey,
  DROP CONSTRAINT agent_account_bindings_company_fkey,DROP COLUMN company_id;
ALTER TABLE quota_window_state DROP CONSTRAINT quota_window_state_account_company_fkey,
  DROP CONSTRAINT quota_window_state_company_fkey,DROP COLUMN company_id;
ALTER TABLE console_agent_favorites DROP CONSTRAINT console_agent_favorites_human_company_fkey,
  DROP CONSTRAINT console_agent_favorites_company_fkey,DROP COLUMN company_id;
ALTER TABLE human_tenant_memberships DROP CONSTRAINT human_tenant_memberships_human_company_fkey,
  DROP CONSTRAINT human_tenant_memberships_company_fkey,DROP COLUMN company_id;
ALTER TABLE provider_accounts DROP CONSTRAINT provider_accounts_id_company_key,
  DROP CONSTRAINT provider_accounts_company_fkey,DROP COLUMN company_id;
ALTER TABLE console_users DROP CONSTRAINT console_users_id_company_key,
  DROP CONSTRAINT console_users_company_fkey,DROP COLUMN company_id;
-- Hosts registered by the backfill or by a placement stay registered; V4.0 lists them like any other.
ALTER TABLE fleet_hosts DROP CONSTRAINT fleet_hosts_host_company_key,DROP COLUMN company_id;
ALTER TABLE fleet_operations DROP COLUMN company_id;
ALTER TABLE config_revisions DROP CONSTRAINT config_revisions_scope_company,DROP CONSTRAINT config_revisions_scope_check,
  DROP COLUMN scope,DROP COLUMN company_id,DROP COLUMN actor_human_id,DROP COLUMN platform_override;
ALTER TABLE audit_events DROP COLUMN company_id,DROP COLUMN actor_human_id;
ALTER TABLE rooms DROP CONSTRAINT rooms_company_id_id_key,DROP CONSTRAINT rooms_company_fkey,
  DROP CONSTRAINT rooms_pkey,DROP COLUMN company_id;
ALTER TABLE rooms ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);
ALTER TABLE memberships ADD CONSTRAINT memberships_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id);
ALTER TABLE messages ADD CONSTRAINT messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id);
ALTER TABLE messages DROP CONSTRAINT messages_room_id_tenant_id_fkey;
ALTER TABLE tenants DROP CONSTRAINT tenants_id_company_key;

DROP FUNCTION cauce_quota_company_guard();
DROP FUNCTION cauce_append_only();
DROP FUNCTION cauce_config_revision_company();
DROP FUNCTION cauce_config_revision_scope(jsonb);
DROP FUNCTION cauce_fill_operation_company();
DROP FUNCTION cauce_register_placed_host();
DROP FUNCTION cauce_fill_host_company();
DROP FUNCTION cauce_pair_company_guard();
DROP FUNCTION cauce_assert_company_reachable(text,text);
DROP FUNCTION cauce_tenants_company_admission();
DROP FUNCTION cauce_company_immutable();
DROP FUNCTION cauce_fill_company_from_human();
DROP FUNCTION cauce_fill_company();
DROP FUNCTION cauce_platform_operator();
DELETE FROM schema_migration_ledger WHERE version='053_company_isolation.sql';
DELETE FROM schema_migrations WHERE version='053_company_isolation.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
