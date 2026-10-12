SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_055);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'055_company_registration.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'055_company_registration.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 055 while a later migration is present';
  END IF;
END
$$;
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
