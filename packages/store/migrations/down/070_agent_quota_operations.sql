SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_070);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'070_agent_quota_operations.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'070_agent_quota_operations.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 070 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='070_agent_quota_operations.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='070_agent_quota_operations.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='070_agent_quota_operations.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'cf4c7ecde418b04c532810f80aeb9e9580f7ef578796f2621a4ee257ca20ab9a'))
    OR ((to_regclass('public.agent_quota_operations') IS NOT NULL
      OR to_regclass('public.agent_quota_observations') IS NOT NULL
      OR to_regprocedure('public.cauce_runtime_grants_070()') IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='070_agent_quota_operations.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 070 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
DO $$
BEGIN
  IF to_regclass('public.agent_quota_operations') IS NOT NULL THEN
    LOCK TABLE agent_quota_operations IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM agent_quota_operations) THEN
      RAISE EXCEPTION 'export agent quota operations before reverting';
    END IF;
  END IF;
END
$$;
DROP FUNCTION IF EXISTS cauce_runtime_grants_070();
DROP TABLE IF EXISTS agent_quota_observations;
DROP TABLE IF EXISTS agent_quota_operations;
DELETE FROM schema_migration_ledger WHERE version='070_agent_quota_operations.sql';
DELETE FROM schema_migrations WHERE version='070_agent_quota_operations.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
