SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_054);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE tenants,agent_role_templates,agents,companies,company_links,console_users,egress_destinations,
  platform_admins,rooms,company_admins,platform_authority_events,company_system_principals,company_agent_roles,
  agent_role_template_owners IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>'054_company_admins.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 054 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM company_admins WHERE role='owner' OR source<>'v4.0-hub-operator')
    OR (SELECT count(*) FROM companies)>1 OR EXISTS (SELECT 1 FROM platform_authority_events)
    OR EXISTS (SELECT 1 FROM agent_role_template_owners)
    OR EXISTS (SELECT company_id,kind,tenant_id,room_id,actor_alias,principal_alias,recipient_alias,notify_handle
      FROM company_system_principals EXCEPT VALUES
        ('humanizar','gate_probe','Steven','grp.steven','kant','gate-probe',NULL::text,NULL::text),
        ('humanizar','director','Steven',NULL,NULL,'argos',NULL,NULL))
    OR EXISTS (SELECT company_id,role,tenant_id,alias FROM company_agent_roles EXCEPT VALUES
        ('humanizar','infra_escalation','Steven','zeus'),('humanizar','coordination','Steven','kant')) THEN
    RAISE EXCEPTION 'rollback preserves company authority; owners, grants, history or principals cannot be removed';
  END IF;
END;
$$;

DROP TRIGGER companies_platform_write ON companies;
DROP TRIGGER companies_owner_required ON companies;
DROP TRIGGER company_links_platform_write ON company_links;
DROP TRIGGER platform_admins_platform_write ON platform_admins;
DROP TRIGGER platform_admins_journal ON platform_admins;
DROP TRIGGER console_users_owner_guard ON console_users;
DROP TRIGGER agents_role_template_company_guard ON agents;
DROP TABLE agent_role_template_owners,company_agent_roles,company_system_principals,platform_authority_events,company_admins;
DROP FUNCTION cauce_platform_revoke_admin(text,uuid,uuid);
DROP FUNCTION cauce_platform_grant_admin(text,uuid,text,text,uuid);
DROP FUNCTION cauce_platform_unlink(text,text,uuid);
DROP FUNCTION cauce_platform_link(text,text,uuid);
DROP FUNCTION cauce_platform_set_company_state(text,text,uuid);
DROP FUNCTION cauce_platform_create_company(text,text,uuid);
DROP FUNCTION cauce_platform_admins_journal();
DROP FUNCTION cauce_platform_assert_admin(uuid);
DROP FUNCTION cauce_platform_record(text,text,text,uuid,uuid,jsonb);
DROP FUNCTION cauce_company_authority(uuid,text);
DROP FUNCTION cauce_console_users_owner_guard();
DROP FUNCTION cauce_company_owner_continuity();
DROP FUNCTION cauce_lock_owner_guard(text);
DROP FUNCTION cauce_platform_plane_guard();
DROP FUNCTION cauce_role_template_company_guard();
DELETE FROM schema_migration_ledger WHERE version='054_company_admins.sql';
DELETE FROM schema_migrations WHERE version='054_company_admins.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
