SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_059);
DO $$ BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'059_host_enrollment.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'059_host_enrollment.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 059 while a later migration is present';
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
