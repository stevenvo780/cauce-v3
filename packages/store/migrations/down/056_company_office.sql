SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_056);
DO $$ BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'056_company_office.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'056_company_office.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 056 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='056_company_office.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='056_company_office.sql')
    OR (to_regclass('public.company_office_layouts') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='056_company_office.sql'))
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='056_company_office.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'7300ebfb17c196a8709002312c6b58dac2bf436ce22e818a24a2f737faf56be6')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 056 from an inconsistent atomic ledger state';
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
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
