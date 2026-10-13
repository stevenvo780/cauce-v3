SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_062);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'062_authority_read_guard.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'062_authority_read_guard.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 062 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='062_authority_read_guard.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='062_authority_read_guard.sql')
    OR (to_regprocedure('public.cauce_runtime_grants_062()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='062_authority_read_guard.sql'))
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='062_authority_read_guard.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'1055b6580ca6c8f9157314311d73a70d6070ac0c8d502c7d160202df75f2e279')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 062 from an inconsistent atomic ledger state';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_062();
DROP FUNCTION IF EXISTS cauce_lock_authority_read_guard();
DELETE FROM schema_migration_ledger WHERE version='062_authority_read_guard.sql';
DELETE FROM schema_migrations WHERE version='062_authority_read_guard.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
