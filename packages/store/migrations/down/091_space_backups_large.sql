SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_060);
SELECT pg_advisory_xact_lock(783_003_091);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'091_space_backups_large.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'091_space_backups_large.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 091 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='091_space_backups_large.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='091_space_backups_large.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='091_space_backups_large.sql'
      AND (source_origin<>'applied-atomically' OR source_sha256<>'905bca37248e29a8426ed046069aaef7f25d822d56f9d93e88528315c1431fd1'))
    OR (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='space_backups'
      AND column_name='bytes' AND data_type='bigint')
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='091_space_backups_large.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 091 from an inconsistent atomic ledger state';
  END IF;
END
$$;
LOCK TABLE space_backups IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM space_backups WHERE bytes>1073741824 OR received_bytes>1073741824) THEN
    RAISE EXCEPTION 'large space backups must be exported and removed before rollback';
  END IF;
END
$$;
ALTER TABLE space_backups
  DROP CONSTRAINT space_backups_received_bytes_check,
  DROP CONSTRAINT space_backups_bytes_check,
  ALTER COLUMN received_bytes TYPE integer,
  ALTER COLUMN bytes TYPE integer;
ALTER TABLE space_backups
  ADD CONSTRAINT space_backups_received_bytes_check CHECK (received_bytes BETWEEN 0 AND 1073741824),
  ADD CONSTRAINT space_backups_bytes_check CHECK (bytes BETWEEN 1 AND 1073741824);
DELETE FROM schema_migration_ledger WHERE version='091_space_backups_large.sql';
DELETE FROM schema_migrations WHERE version='091_space_backups_large.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
