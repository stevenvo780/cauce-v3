SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_056);
DO $$ BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'056_company_office.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'056_company_office.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 056 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM company_office_layouts) OR EXISTS (SELECT 1 FROM console_company_preferences) THEN
    RAISE EXCEPTION 'export persisted office layouts before reverting';
  END IF;
END $$;
DROP FUNCTION cauce_runtime_grants_056();
DROP TABLE console_company_preferences;
DROP TABLE company_office_layouts;
DELETE FROM schema_migration_ledger WHERE version='056_company_office.sql';
DELETE FROM schema_migrations WHERE version='056_company_office.sql';
