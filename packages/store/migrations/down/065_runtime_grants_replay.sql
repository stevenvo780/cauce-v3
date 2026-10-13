SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_065);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'065_runtime_grants_replay.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'065_runtime_grants_replay.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 065 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='065_runtime_grants_replay.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='065_runtime_grants_replay.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='065_runtime_grants_replay.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'e24a85a02cc2b3be840d5b674d2388b9f46b8d696b6d89e918b2b5c45087b052'))
    OR (to_regprocedure('public.cauce_runtime_grants_065()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='065_runtime_grants_replay.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 065 from an inconsistent atomic ledger state';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_065();
DELETE FROM schema_migration_ledger WHERE version='065_runtime_grants_replay.sql';
DELETE FROM schema_migrations WHERE version='065_runtime_grants_replay.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
