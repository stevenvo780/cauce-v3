SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_055);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'055_company_registration.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'055_company_registration.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 055 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='055_company_registration.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='055_company_registration.sql')
    OR (to_regclass('public.company_admin_versions') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='055_company_registration.sql'))
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='055_company_registration.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'6eafe2dae7ed74c8305665ccdc517957e10af4117e2cd7ad5725b7253b293814')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 055 from an inconsistent atomic ledger state';
  END IF;
END
$$;
LOCK TABLE company_admins,company_admin_versions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM company_admins WHERE version<>1)
    OR EXISTS (SELECT 1 FROM company_admin_versions history WHERE history.version<>1 OR NOT EXISTS (
      SELECT 1 FROM company_admins admin WHERE admin.company_id=history.company_id AND admin.human_id=history.human_id)) THEN
    RAISE EXCEPTION 'rollback preserves company administrator history; versions or revocations cannot be removed';
  END IF;
END $$;
DROP FUNCTION cauce_runtime_grants_055();
DROP FUNCTION cauce_set_company_admin(text,uuid,uuid,text,bigint);
DROP FUNCTION cauce_assert_qualified_company_owner(text);
DROP TABLE company_admin_versions;
ALTER TABLE company_admins DROP COLUMN version;
DROP FUNCTION cauce_update_company(text,uuid,bigint,text,text);
DROP FUNCTION cauce_require_company_owner(text,uuid);
DROP FUNCTION cauce_register_company(text,text,text,text,text);
DELETE FROM schema_migration_ledger WHERE version='055_company_registration.sql';
DELETE FROM schema_migrations WHERE version='055_company_registration.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
