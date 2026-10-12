SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_062);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'062_authority_read_guard.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'062_authority_read_guard.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 062 while a later migration is present';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_062();
DROP FUNCTION IF EXISTS cauce_lock_authority_read_guard();
DELETE FROM schema_migration_ledger WHERE version='062_authority_read_guard.sql';
DELETE FROM schema_migrations WHERE version='062_authority_read_guard.sql';
