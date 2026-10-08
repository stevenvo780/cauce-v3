SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_050);
LOCK TABLE fleet_hosts IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>'050_fleet_hosts.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 050 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_hosts) THEN
    RAISE EXCEPTION 'rollback preserves registered fleet hosts; populated host schema cannot be removed';
  END IF;
END;
$$;
DROP TABLE fleet_hosts;
DELETE FROM schema_migration_ledger WHERE version='050_fleet_hosts.sql';
DELETE FROM schema_migrations WHERE version='050_fleet_hosts.sql';
