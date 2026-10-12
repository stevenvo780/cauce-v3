SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_067);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'067_context_history_immutable.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'067_context_history_immutable.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 067 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='067_context_history_immutable.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='067_context_history_immutable.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='067_context_history_immutable.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'4833b1cd705c4f83b4b2da1fa8b7427bebfaec9bb99ff2872339718f379e3bdc'))
    OR (to_regprocedure('public.cauce_runtime_grants_067()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='067_context_history_immutable.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 067 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
DROP TRIGGER IF EXISTS agent_context_versions_immutable ON agent_context_versions;
DROP FUNCTION IF EXISTS cauce_runtime_grants_067();
DROP FUNCTION IF EXISTS cauce_context_history_immutable();
DELETE FROM schema_migration_ledger WHERE version='067_context_history_immutable.sql';
DELETE FROM schema_migrations WHERE version='067_context_history_immutable.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
