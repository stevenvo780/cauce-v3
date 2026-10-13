SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_059);
DO $$ BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'059_host_enrollment.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'059_host_enrollment.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 059 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='059_host_enrollment.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='059_host_enrollment.sql')
    OR (to_regclass('public.fleet_host_enrollments') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='059_host_enrollment.sql'))
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='059_host_enrollment.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'559cabeafbe4bce3f087cf21fd7bb201d238c5416c5f07987888ca9055719184')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 059 from an inconsistent atomic ledger state';
  END IF;
  IF EXISTS(SELECT 1 FROM fleet_host_identities) OR EXISTS(SELECT 1 FROM fleet_host_enrollments) THEN
    RAISE EXCEPTION 'export and revoke host identities before reverting';
  END IF;
END $$;
DROP FUNCTION cauce_runtime_grants_059();
DROP FUNCTION cauce_lock_host_company(text);
DROP TABLE fleet_host_request_nonces;
DROP TABLE fleet_host_identities;
DROP TABLE fleet_host_enrollments;
DELETE FROM schema_migration_ledger WHERE version='059_host_enrollment.sql';
DELETE FROM schema_migrations WHERE version='059_host_enrollment.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
