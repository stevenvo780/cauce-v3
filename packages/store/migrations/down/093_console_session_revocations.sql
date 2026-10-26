SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_093);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'093_console_session_revocations.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'093_console_session_revocations.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 093 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='093_console_session_revocations.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='093_console_session_revocations.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='093_console_session_revocations.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'f59f64c0b67456a54a2939514cb55dbd9fd25bf727fe3c1731cf9c12e0da5c52')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 093 from an inconsistent atomic ledger state';
  END IF;
END $$;
LOCK TABLE console_session_revocations IN ACCESS EXCLUSIVE MODE;
DROP TABLE console_session_revocations;
DROP FUNCTION cauce_runtime_grants_093();
DELETE FROM schema_migration_ledger WHERE version='093_console_session_revocations.sql';
DELETE FROM schema_migrations WHERE version='093_console_session_revocations.sql';
