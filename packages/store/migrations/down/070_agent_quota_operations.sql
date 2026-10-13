SELECT pg_advisory_xact_lock(783_003_070);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'070_agent_quota_operations.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'070_agent_quota_operations.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 070 while a later migration is present';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_070();
DROP TABLE IF EXISTS agent_quota_observations;
DROP TABLE IF EXISTS agent_quota_operations;
DELETE FROM schema_migration_ledger WHERE version='070_agent_quota_operations.sql';
DELETE FROM schema_migrations WHERE version='070_agent_quota_operations.sql';
