SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_094);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'094_device_authorization_session_anchor.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'094_device_authorization_session_anchor.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 094 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='094_device_authorization_session_anchor.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='094_device_authorization_session_anchor.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='094_device_authorization_session_anchor.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'643ecf22f7d8c57f6ea504e8ba0ed455bb0abe8a41c222236c478b966d0fed33')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 094 from an inconsistent atomic ledger state';
  END IF;
END $$;
LOCK TABLE device_authorizations IN ACCESS EXCLUSIVE MODE;
DROP TRIGGER device_authorization_session_anchor ON device_authorizations;
DROP FUNCTION cauce_device_authorization_session_anchor();
ALTER TABLE device_authorizations DROP CONSTRAINT device_authorizations_session_auth_at_decided;
ALTER TABLE device_authorizations DROP COLUMN session_auth_at;
DROP FUNCTION cauce_runtime_grants_094();
DELETE FROM schema_migration_ledger WHERE version='094_device_authorization_session_anchor.sql';
DELETE FROM schema_migrations WHERE version='094_device_authorization_session_anchor.sql';
