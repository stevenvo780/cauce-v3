SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_082);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>'082_company_purge.sql'
    UNION ALL SELECT 1 FROM schema_migration_ledger WHERE version>'082_company_purge.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 082 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='082_company_purge.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='082_company_purge.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='082_company_purge.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'450e400558a9914ab6feb348ccf1daae8732f27d15769d7dfdce3f5480e7794b'))
    OR (to_regprocedure('public.cauce_runtime_grants_082()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='082_company_purge.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 082 from an inconsistent atomic ledger state';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_082();
DROP FUNCTION IF EXISTS cauce_purge_company(text,uuid,text,text,text);
DROP FUNCTION IF EXISTS cauce_prepare_company_purge(text,uuid);
DROP FUNCTION IF EXISTS cauce_company_purge_data(text,uuid);
DELETE FROM schema_migration_ledger WHERE version='082_company_purge.sql';
DELETE FROM schema_migrations WHERE version='082_company_purge.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
