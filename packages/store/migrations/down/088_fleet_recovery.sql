SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_088);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'088_fleet_recovery.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'088_fleet_recovery.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 088 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='088_fleet_recovery.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='088_fleet_recovery.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='088_fleet_recovery.sql'
      AND (source_origin<>'applied-atomically' OR source_sha256<>'88c60ebd5221f637a62a0376e521e1f97363bf3d39a83100e7dd4ecd110a78b3')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 088 from an inconsistent atomic ledger state';
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_operations WHERE kind='recover') THEN
    RAISE EXCEPTION 'cannot downgrade schema 088 while durable recovery operations exist';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);

ALTER TABLE fleet_operations DROP CONSTRAINT fleet_operations_kind_check;
ALTER TABLE fleet_operations ADD CONSTRAINT fleet_operations_kind_check
  CHECK (kind IN ('create','update','start','stop','retire','restore','purge'));

DELETE FROM schema_migration_ledger WHERE version='088_fleet_recovery.sql';
DELETE FROM schema_migrations WHERE version='088_fleet_recovery.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
