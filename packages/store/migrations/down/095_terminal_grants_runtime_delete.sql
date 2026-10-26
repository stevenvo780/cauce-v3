SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_095);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'095_terminal_grants_runtime_delete.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'095_terminal_grants_runtime_delete.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 095 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='095_terminal_grants_runtime_delete.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='095_terminal_grants_runtime_delete.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='095_terminal_grants_runtime_delete.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'77e273811a0e1aa9eae85b19435eb8c46bce7a1da8ecd15831f0e65384d382a8')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 095 from an inconsistent atomic ledger state';
  END IF;
END $$;
REVOKE DELETE ON terminal_grants FROM cauce_runtime;
DROP FUNCTION cauce_runtime_grants_095();
DELETE FROM schema_migration_ledger WHERE version='095_terminal_grants_runtime_delete.sql';
DELETE FROM schema_migrations WHERE version='095_terminal_grants_runtime_delete.sql';
