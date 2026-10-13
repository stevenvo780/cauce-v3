SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_061);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'061_people_admin_history.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'061_people_admin_history.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 061 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='061_people_admin_history.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='061_people_admin_history.sql')
    OR (to_regprocedure('public.cauce_runtime_grants_061()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='061_people_admin_history.sql'))
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='061_people_admin_history.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'87fd927ecf9a17580908b630ed70f8446efabe11ec10577db34f3a4d945aa2d6')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 061 from an inconsistent atomic ledger state';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_061();
DROP FUNCTION IF EXISTS cauce_human_has_admin_history(uuid);
DELETE FROM schema_migration_ledger WHERE version='061_people_admin_history.sql';
DELETE FROM schema_migrations WHERE version='061_people_admin_history.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
