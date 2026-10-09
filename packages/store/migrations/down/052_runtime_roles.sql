SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_052);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE audit_events,harness_definitions,role_policies IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>'052_runtime_roles.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 052 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity activity JOIN pg_roles login ON login.oid=activity.usesysid
    WHERE activity.datname=current_database() AND NOT login.rolsuper
      AND (pg_has_role(login.oid,'cauce_runtime','MEMBER') OR pg_has_role(login.oid,'cauce_observer','MEMBER'))) THEN
    RAISE EXCEPTION 'a runtime or observer login is still connected; switch it back to the migrator role first';
  END IF;
END;
$$;

DROP TRIGGER audit_events_platform_rewrite ON audit_events;
DROP TRIGGER role_policies_platform_write ON role_policies;
DROP TRIGGER harness_definitions_platform_write ON harness_definitions;
DROP FUNCTION cauce_platform_write_guard();
DROP FUNCTION cauce_apply_runtime_grants();
DROP FUNCTION cauce_runtime_grants_052();
ALTER FUNCTION cauce_lock_company_link(text,text) SET search_path=pg_catalog,public;
ALTER FUNCTION cauce_lock_hub_star_tenant(text) SET search_path=pg_catalog,public;
-- Revoke only what names a group: a blanket REVOKE would materialize default ACLs on every other object.
-- The roles belong to the cluster: when another database still grants them something they stay as
-- inert groups instead of failing the rollback. Dropping a group would silently drop the memberships
-- of its logins, which a later 052 does not restore, so that refuses instead.
DO $$
DECLARE
  target record;
  group_role text;
BEGIN
  FOR target IN SELECT c.oid::regclass AS relation,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) entry
      WHERE entry.grantee IN ('cauce_runtime'::regrole,'cauce_observer'::regrole)) LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM cauce_runtime,cauce_observer',
      CASE WHEN target.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,target.relation);
  END LOOP;
  FOR target IN SELECT p.oid::regprocedure AS routine FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) entry
      WHERE entry.grantee IN ('cauce_runtime'::regrole,'cauce_observer'::regrole,'cauce_platform'::regrole)) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM cauce_runtime,cauce_observer,cauce_platform',target.routine);
  END LOOP;
  REVOKE USAGE ON SCHEMA public FROM cauce_runtime,cauce_observer;
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM cauce_runtime,cauce_observer',current_database());
  FOREACH group_role IN ARRAY ARRAY['cauce_runtime','cauce_observer','cauce_platform'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_shdepend dependency JOIN pg_roles role ON role.oid=dependency.refobjid
      WHERE dependency.refclassid='pg_authid'::regclass AND role.rolname=group_role) THEN
      IF group_role<>'cauce_platform' AND EXISTS (SELECT 1 FROM pg_auth_members membership
        WHERE membership.roleid=group_role::regrole) THEN
        RAISE EXCEPTION '% still has member logins; drop them or revoke their membership first',group_role;
      END IF;
      EXECUTE format('DROP ROLE %I',group_role);
    END IF;
  END LOOP;
END;
$$;
DELETE FROM schema_migration_ledger WHERE version='052_runtime_roles.sql';
DELETE FROM schema_migrations WHERE version='052_runtime_roles.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
