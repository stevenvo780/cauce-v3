SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_060);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'060_space_backups.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'060_space_backups.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 060 while a later migration is present';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_060();
DROP TABLE IF EXISTS space_backups;
DELETE FROM schema_migration_ledger WHERE version='060_space_backups.sql';
DELETE FROM schema_migrations WHERE version='060_space_backups.sql';
