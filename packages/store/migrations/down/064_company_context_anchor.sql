SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_064);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'064_company_context_anchor.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'064_company_context_anchor.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 064 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='064_company_context_anchor.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='064_company_context_anchor.sql')
    OR (to_regprocedure('public.cauce_ensure_context_director_anchor(text,text,text,bigint,text)') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='064_company_context_anchor.sql'))
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='064_company_context_anchor.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'afe0bd6797a120a55f16bcccdd583573ad15b6b3c233967d50adf27852851495')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 064 from an inconsistent atomic ledger state';
  END IF;
END
$$;
DROP FUNCTION cauce_ensure_context_director_anchor(text,text,text,bigint,text);
DELETE FROM schema_migration_ledger WHERE version='064_company_context_anchor.sql';
DELETE FROM schema_migrations WHERE version='064_company_context_anchor.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
