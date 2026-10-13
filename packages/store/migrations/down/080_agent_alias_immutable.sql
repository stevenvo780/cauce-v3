SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_080);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'080_agent_alias_immutable.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'080_agent_alias_immutable.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 080 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='080_agent_alias_immutable.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='080_agent_alias_immutable.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='080_agent_alias_immutable.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'667a6068ef47477bb20d77f82380489936870e646a0ffbe5439d04c81bea493e'))
    OR (to_regprocedure('public.cauce_runtime_grants_080()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='080_agent_alias_immutable.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 080 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
DROP TRIGGER IF EXISTS agents_alias_immutable ON agents;
DROP FUNCTION IF EXISTS cauce_runtime_grants_080();
DROP FUNCTION IF EXISTS cauce_agents_alias_immutable();
DELETE FROM schema_migration_ledger WHERE version='080_agent_alias_immutable.sql';
DELETE FROM schema_migrations WHERE version='080_agent_alias_immutable.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
