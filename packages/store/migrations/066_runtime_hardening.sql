SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_066);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE agent_chain_policies IN SHARE ROW EXCLUSIVE MODE;

-- An unlisted pg_temp is searched first for relations and types. The runtime kept TEMPORARY on the
-- database, so a temporary table named messages or acl_edges let a runtime login skip the hub-star
-- guards of deliveries and tenants. Every function of public whose body names a relation or a type
-- of public now lists pg_temp last. The list is the catalog query that closes this migration, run
-- on schema 065; pure SQL helpers such as cauce_text_items_ok are left alone, because a SET clause
-- would stop their inlining in CHECK constraints (038).
ALTER FUNCTION cauce_agent_profile_context_journal() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_agents_role_brief_journal() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_agents_role_template_coherence() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_company_links_withdraw_edges() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_deliveries_hub_star_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_dlq_apply_030(text,text,text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_dlq_assert_control_030(text,text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_dlq_can_control_tenant_030(text,text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_dlq_candidates_030() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_dlq_lock_control_tenant_030(text,text,text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_dlq_post_030(text,text,text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_dlq_snapshot_030(text,text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_egress_destination_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_fence_adapter_outbox_causality_030() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_fence_dead_letter_030() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_fence_outbox_dead_letter_030() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_fence_telegram_effect_030() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_inspect_telegram_replay_030(uuid,text,text,text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_legacy_company_id() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_list_dlq_030(text,text,integer,text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_manual_replay_telegram_030(text,integer,text,text,text,boolean,uuid,uuid,text,integer)
  SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_oauth_advance_identity_revision() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_oauth_preserve_authority() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_oauth_reject_truncate() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_profile_runtime_adoption_matches_expectation() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_reconcile_telegram_terminal_030(text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_reopen_outbox_dead_letter_030() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_resolve_dlq_without_replay_030(text,uuid,text,text,text,text,boolean,boolean)
  SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_sync_agent_role_to_profile() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_sync_profile_role_to_agent() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_sync_role_template_to_profiles() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_tenants_hub_star_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION enforce_human_identity_immutability() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION preserve_fleet_operation_history() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION preserve_human_client_records() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION reserve_agent_runtime_key() SET search_path=pg_catalog,public,pg_temp;

-- A chain policy governs every company, so 053 records it in platform revisions like harnesses and
-- role policies; unlike them it stayed writable by the runtime without one. At commit, the
-- transaction that wrote a policy must also have recorded a platform revision of that policy,
-- unless it runs as the platform. A visible revision whose writer is still in progress belongs to
-- this transaction or to one of its subtransactions. Their xids follow the top-level one, so the
-- 32-bit xmin of a revision stamped at this transaction's start is widened from it.
CREATE FUNCTION cauce_chain_policy_revision_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  policy_id text := CASE TG_OP WHEN 'DELETE' THEN OLD.id ELSE NEW.id END;
  top_xid bigint;
BEGIN
  IF cauce_platform_operator() THEN RETURN NULL; END IF;
  top_xid := pg_current_xact_id()::text::bigint;
  IF EXISTS (SELECT 1 FROM config_revisions revision
      CROSS JOIN LATERAL (SELECT revision.xmin::text::bigint AS low,
        (revision.xmin::text::bigint-top_xid%4294967296+4294967296)%4294967296 AS ahead) writer
      WHERE revision.scope='platform'
        AND (revision.operation @> jsonb_build_object('resource','chain_policy','id',policy_id)
          OR (revision.operation->>'resource'='batch'
            AND revision.operation->'mutations' @> jsonb_build_array(jsonb_build_object('resource','chain_policy','id',policy_id))))
        AND CASE WHEN revision.created_at=now() AND writer.low>=3 AND writer.ahead<2147483648
          THEN pg_xact_status((top_xid+writer.ahead)::text::xid8)='in progress' ELSE false END) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'agent_chain_policies % changes only with a platform configuration revision',policy_id
    USING ERRCODE='42501', TABLE='agent_chain_policies', CONSTRAINT='agent_chain_policies_platform_revision';
END
$$;
CREATE CONSTRAINT TRIGGER agent_chain_policies_platform_revision
  AFTER INSERT OR UPDATE OR DELETE ON agent_chain_policies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cauce_chain_policy_revision_guard();

-- The grants of 066, replayed by cauce_apply_runtime_grants() of 052 after a restore: a new database
-- grants TEMPORARY to PUBLIC again, and no runtime path creates temporary objects.
CREATE FUNCTION cauce_runtime_grants_066()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC,cauce_runtime,cauce_observer',current_database());
  REVOKE ALL ON FUNCTION cauce_chain_policy_revision_guard(),cauce_runtime_grants_066() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_chain_policy_revision_guard(),cauce_runtime_grants_066() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_066();

DO $$
DECLARE
  unpinned text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text,', ' ORDER BY p.oid::regprocedure::text) INTO unpinned
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN ('f','p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid='pg_proc'::regclass
      AND dependency.objid=p.oid AND dependency.deptype='e')
    AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) setting WHERE setting ~ '^search_path=.+, pg_temp$')
    AND EXISTS (SELECT 1 FROM pg_class relation WHERE relation.relnamespace='public'::regnamespace
        AND p.prosrc ~* ('\m'||relation.relname||'\M')
      UNION ALL SELECT 1 FROM pg_type type WHERE type.typnamespace='public'::regnamespace
        AND p.prosrc ~* ('\m'||type.typname||'\M'));
  IF unpinned IS NOT NULL THEN
    RAISE EXCEPTION 'functions that name relations without pg_temp last in search_path: %',unpinned
      USING ERRCODE='42501';
  END IF;
END
$$;
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
