SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_090);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'090_runtime_catalog_guard.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'090_runtime_catalog_guard.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 090 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='090_runtime_catalog_guard.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='090_runtime_catalog_guard.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='090_runtime_catalog_guard.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'030f1cc0324daf198179bfad8824f99d71e745382c305a15e0884500d99b9b28'))
    OR (to_regprocedure('public.cauce_runtime_grants_090()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='090_runtime_catalog_guard.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 090 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);

ALTER FUNCTION public.cauce_platform_write_guard() SET search_path=pg_catalog;
DROP FUNCTION IF EXISTS cauce_runtime_grants_090();
DELETE FROM schema_migration_ledger WHERE version='090_runtime_catalog_guard.sql';
DELETE FROM schema_migrations WHERE version='090_runtime_catalog_guard.sql';

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
