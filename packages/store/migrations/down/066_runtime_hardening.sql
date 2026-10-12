SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_066);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'066_runtime_hardening.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'066_runtime_hardening.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 066 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='066_runtime_hardening.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='066_runtime_hardening.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='066_runtime_hardening.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'ee2c9ceabf20307d96a2d00dba910cea991be487e896fe4e0120e5b0c6638d62'))
    OR (to_regprocedure('public.cauce_runtime_grants_066()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='066_runtime_hardening.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 066 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
DROP TRIGGER IF EXISTS agent_chain_policies_platform_revision ON agent_chain_policies;
DROP FUNCTION IF EXISTS cauce_chain_policy_revision_guard();
DROP FUNCTION IF EXISTS cauce_runtime_grants_066();
-- PostgreSQL grants TEMPORARY to PUBLIC by default and 052-065 never revoked it.
DO $$
BEGIN
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC',current_database());
END
$$;
ALTER FUNCTION cauce_agent_profile_context_journal() RESET search_path;
ALTER FUNCTION cauce_agents_role_brief_journal() RESET search_path;
ALTER FUNCTION cauce_agents_role_template_coherence() RESET search_path;
ALTER FUNCTION cauce_company_links_withdraw_edges() RESET search_path;
ALTER FUNCTION cauce_deliveries_hub_star_guard() RESET search_path;
ALTER FUNCTION cauce_dlq_apply_030(text,text,text) RESET search_path;
ALTER FUNCTION cauce_dlq_assert_control_030(text,text) RESET search_path;
ALTER FUNCTION cauce_dlq_can_control_tenant_030(text,text) RESET search_path;
ALTER FUNCTION cauce_dlq_candidates_030() RESET search_path;
ALTER FUNCTION cauce_dlq_lock_control_tenant_030(text,text,text) RESET search_path;
ALTER FUNCTION cauce_dlq_post_030(text,text,text) RESET search_path;
ALTER FUNCTION cauce_dlq_snapshot_030(text,text) RESET search_path;
ALTER FUNCTION cauce_egress_destination_guard() RESET search_path;
ALTER FUNCTION cauce_fence_adapter_outbox_causality_030() RESET search_path;
ALTER FUNCTION cauce_fence_dead_letter_030() RESET search_path;
ALTER FUNCTION cauce_fence_outbox_dead_letter_030() RESET search_path;
ALTER FUNCTION cauce_fence_telegram_effect_030() RESET search_path;
ALTER FUNCTION cauce_inspect_telegram_replay_030(uuid,text,text,text) RESET search_path;
ALTER FUNCTION cauce_legacy_company_id() SET search_path=pg_catalog,public;
ALTER FUNCTION cauce_list_dlq_030(text,text,integer,text) RESET search_path;
ALTER FUNCTION cauce_manual_replay_telegram_030(text,integer,text,text,text,boolean,uuid,uuid,text,integer) RESET search_path;
ALTER FUNCTION cauce_oauth_advance_identity_revision() RESET search_path;
ALTER FUNCTION cauce_oauth_preserve_authority() RESET search_path;
ALTER FUNCTION cauce_oauth_reject_truncate() RESET search_path;
ALTER FUNCTION cauce_profile_runtime_adoption_matches_expectation() RESET search_path;
ALTER FUNCTION cauce_reconcile_telegram_terminal_030(text) RESET search_path;
ALTER FUNCTION cauce_reopen_outbox_dead_letter_030() RESET search_path;
ALTER FUNCTION cauce_resolve_dlq_without_replay_030(text,uuid,text,text,text,text,boolean,boolean) RESET search_path;
ALTER FUNCTION cauce_sync_agent_role_to_profile() RESET search_path;
ALTER FUNCTION cauce_sync_profile_role_to_agent() RESET search_path;
ALTER FUNCTION cauce_sync_role_template_to_profiles() RESET search_path;
ALTER FUNCTION cauce_tenants_hub_star_guard() RESET search_path;
ALTER FUNCTION enforce_human_identity_immutability() RESET search_path;
ALTER FUNCTION preserve_fleet_operation_history() RESET search_path;
ALTER FUNCTION preserve_human_client_records() RESET search_path;
ALTER FUNCTION reserve_agent_runtime_key() RESET search_path;
DELETE FROM schema_migration_ledger WHERE version='066_runtime_hardening.sql';
DELETE FROM schema_migrations WHERE version='066_runtime_hardening.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
