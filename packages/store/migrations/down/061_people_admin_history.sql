SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_061);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'061_people_admin_history.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'061_people_admin_history.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 061 while a later migration is present';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_061();
DROP FUNCTION IF EXISTS cauce_human_has_admin_history(uuid);
DELETE FROM schema_migration_ledger WHERE version='061_people_admin_history.sql';
DELETE FROM schema_migrations WHERE version='061_people_admin_history.sql';
