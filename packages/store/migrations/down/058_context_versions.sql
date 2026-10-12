SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_058);
DO $$ BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'058_context_versions.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'058_context_versions.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 058 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM agent_context_versions) THEN
    RAISE EXCEPTION 'export context history and outbox before reverting';
  END IF;
END $$;
DROP TABLE agent_context_outbox,agent_context_state,agent_context_versions;
ALTER TABLE deliveries DROP COLUMN context_version,DROP COLUMN context_digest;
DROP FUNCTION cauce_runtime_grants_058(),cauce_context_company();
DELETE FROM schema_migration_ledger WHERE version='058_context_versions.sql';
DELETE FROM schema_migrations WHERE version='058_context_versions.sql';
