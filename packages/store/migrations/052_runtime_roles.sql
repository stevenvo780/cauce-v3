SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_052);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
-- The canonical order of 051 and 053, tenants first, so a bundle with a later migration never inverts it.
LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE audit_events,harness_definitions,role_policies IN SHARE ROW EXCLUSIVE MODE;

-- A restore made with --no-acl keeps schema_migrations at 052 but loses every grant, and a new cluster
-- lacks the roles too, so the grants live in functions: SELECT cauce_apply_runtime_grants() replays
-- them all. A later migration that grants its new objects adds its own cauce_runtime_grants_NNN().
CREATE FUNCTION cauce_apply_runtime_grants()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  routine regprocedure;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname ~ '^cauce_runtime_grants_[0-9]{3}$' AND p.pronargs=0 ORDER BY p.proname LOOP
    EXECUTE format('SELECT %s',routine);
  END LOOP;
END
$$;

CREATE FUNCTION cauce_runtime_grants_052()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- Group roles are cluster-wide and shared by every database of the cluster: a concurrent creator
  -- surfaces as duplicate_object or, while its transaction is open, as unique_violation.
  BEGIN CREATE ROLE cauce_runtime NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END;
  BEGIN CREATE ROLE cauce_observer NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END;
  BEGIN CREATE ROLE cauce_platform NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('cauce_runtime','cauce_observer','cauce_platform')
      AND (rolcanlogin OR (rolname<>'cauce_platform'
        AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))))
    OR EXISTS (SELECT 1 FROM pg_auth_members membership JOIN pg_roles member ON member.oid=membership.member
      WHERE member.rolname IN ('cauce_runtime','cauce_observer')) THEN
    RAISE EXCEPTION 'cauce_runtime and cauce_observer must be unprivileged NOLOGIN leaf groups'
      USING ERRCODE='42501';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cauce_runtime,cauce_observer',current_database());
  GRANT cauce_platform TO CURRENT_USER;
  GRANT USAGE ON SCHEMA public TO cauce_runtime,cauce_observer;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;

  -- Every migration table, sequence and view is listed by class; never ON ALL TABLES, so ad hoc
  -- backup tables stay owner-only.
  GRANT SELECT,INSERT,UPDATE,DELETE ON acl_edges,adapter_inbox,adapter_outbox,agent_account_bindings,
    agent_appearances,agent_chain_closures,agent_chain_edge_uses,agent_chain_gates,agent_chain_progress,
    agent_document_revisions,agent_failure_notice_events,agent_failure_notices,agent_output_materializations,
    agent_profile_revisions,agent_profile_runtime_adoptions,agent_profile_runtime_expectations,agent_profiles,
    agent_role_brief_history,agent_sealing_keys,agents,alias_routing_ceiling,blob_delivery_grants,blobs,
    cauce_oauth_clients,cauce_oauth_codes,cauce_oauth_grant_revocations,cauce_oauth_grants,
    cauce_oauth_refresh_tokens,cauce_oauth_requests,cauce_oauth_tokens,channel_bridge_cursors,
    channel_bridge_leases,connection_leases,console_agent_favorites,console_users,dead_letters,deliveries,
    delivery_acks,delivery_lane_fairness,dlq_operator_resolutions,dlq_reconciliation_runs,
    dlq_reconciliation_transitions,egress_contacts,egress_destinations,egress_notifications,fleet_hosts,
    gateway_oidc_sessions,human_client_delegation_operations,human_external_identities,
    human_message_client_provenance,human_message_initiators,human_oauth_client_delegations,
    human_tenant_memberships,idempotency_keys,job_lane_fairness,jobs,memberships,messages,outbox_dead_letters,
    provider_accounts,quota_collections,quota_provider_reports,quota_window_samples,quota_window_state,rooms,
    secret_handoffs,shadow_compare_verdicts,shadow_human_reply_guards,shadow_router_inbox,shadow_router_mappings,
    telegram_egress_effects,telegram_manual_replays,terminal_control_holds,terminal_sessions TO cauce_runtime;
  GRANT SELECT ON companies,company_links,platform_admins,schema_migrations,schema_migration_ledger,
    schema_migration_verifications,agent_role_templates,cauce_dlq_inventory_030 TO cauce_runtime;
  GRANT SELECT,UPDATE ON agent_chain_policies TO cauce_runtime;
  -- Row locks (FOR SHARE, LOCK TABLE ... SHARE) need UPDATE. The 048 trigger already rejects every change
  -- to fleet_runtime_identities; the guard below rejects catalog writes and audit rewrites.
  GRANT SELECT,UPDATE ON harness_definitions,role_policies TO cauce_runtime;
  GRANT SELECT,INSERT ON fleet_operation_events TO cauce_runtime;
  GRANT SELECT,INSERT,UPDATE ON fleet_operations,fleet_runtime_identities,config_revisions TO cauce_runtime;
  GRANT SELECT,INSERT,UPDATE,DELETE ON audit_events TO cauce_runtime;
  GRANT SELECT,INSERT,DELETE ON tenants TO cauce_runtime;
  GRANT UPDATE(created_at,is_hub,display_name,enabled,retired_at,retired_enabled,purged_at) ON tenants TO cauce_runtime;
  GRANT USAGE,SELECT ON SEQUENCE agent_document_revisions_id_seq,agent_failure_notices_id_seq,
    agent_profile_revisions_id_seq,agent_role_brief_history_id_seq,audit_events_id_seq,config_revisions_id_seq,
    delivery_acks_id_seq,dlq_operator_resolutions_id_seq,dlq_reconciliation_transitions_id_seq,
    fleet_operation_events_id_seq,shadow_compare_verdicts_id_seq,telegram_manual_replays_id_seq TO cauce_runtime;
  REVOKE ALL ON FUNCTION cauce_lock_company_link(text,text),cauce_lock_hub_star_tenant(text),
    cauce_apply_runtime_grants(),cauce_runtime_grants_052() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_lock_company_link(text,text),cauce_lock_hub_star_tenant(text) TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_apply_runtime_grants(),cauce_runtime_grants_052() TO cauce_platform;
  GRANT SELECT ON adapter_outbox,agent_output_materializations,agents,connection_leases,dead_letters,deliveries,
    messages,outbox_dead_letters,tenants TO cauce_observer;
END
$$;

-- Superusers count as members of every role, so the migrator and the operator keep writing.
CREATE FUNCTION cauce_platform_write_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT pg_has_role(current_user,'cauce_platform','MEMBER') THEN
    RAISE EXCEPTION '% on % requires the cauce_platform role',TG_OP,TG_TABLE_NAME USING ERRCODE='42501';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER harness_definitions_platform_write BEFORE INSERT OR UPDATE OR DELETE ON harness_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER role_policies_platform_write BEFORE INSERT OR UPDATE OR DELETE ON role_policies
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER audit_events_platform_rewrite BEFORE UPDATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
-- An unlisted pg_temp is searched first for relations, and the runtime may create temporary tables, so
-- every DEFINER function lists it last.
ALTER FUNCTION cauce_lock_company_link(text,text) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION cauce_lock_hub_star_tenant(text) SET search_path=pg_catalog,public,pg_temp;
SELECT cauce_apply_runtime_grants();
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
