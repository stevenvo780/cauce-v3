SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_089);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'089_device_authorizations.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'089_device_authorizations.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 089 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='089_device_authorizations.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='089_device_authorizations.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='089_device_authorizations.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'8fcf9ac0245982f9933996d496d01d0e9b5c1d5ec4256be6c00d6351ad1a858d')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 089 from an inconsistent atomic ledger state';
  END IF;
END $$;
LOCK TABLE device_authorizations IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM device_authorizations WHERE state IN ('pending','approved') AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'wait for pending device authorizations to expire before reverting schema 089';
  END IF;
END $$;
DROP TABLE device_authorizations;
DROP TRIGGER console_users_device_authority_revision ON console_users;
DROP FUNCTION cauce_device_authorization_transition();
DROP FUNCTION cauce_runtime_grants_089();
DELETE FROM schema_migration_ledger WHERE version='089_device_authorizations.sql';
DELETE FROM schema_migrations WHERE version='089_device_authorizations.sql';
