SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_060);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'060_space_backups.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'060_space_backups.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 060 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='060_space_backups.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='060_space_backups.sql')
    OR (to_regclass('public.space_backups') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='060_space_backups.sql'))
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='060_space_backups.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'06423c614d04cc5fd76c647a3fc178f8ca56f367c19ce839f18a9f047f049ef3')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 060 from an inconsistent atomic ledger state';
  END IF;
END
$$;
DO $$ BEGIN
  IF to_regclass('public.space_backups') IS NOT NULL THEN
    LOCK TABLE space_backups IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM space_backups) THEN
      RAISE EXCEPTION 'space backups must be exported before rollback';
    END IF;
  END IF;
END $$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_060();
DROP TABLE IF EXISTS space_backups;
DELETE FROM schema_migration_ledger WHERE version='060_space_backups.sql';
DELETE FROM schema_migrations WHERE version='060_space_backups.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
