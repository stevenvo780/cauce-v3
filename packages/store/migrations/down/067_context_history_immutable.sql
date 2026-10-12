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
        OR source_sha256<>'374b34189fb02e1bc4dedb9d61bf0e60f82bf87e219eb756015f0f8393375f08'))
    OR (to_regprocedure('public.cauce_runtime_grants_067()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='067_context_history_immutable.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 067 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
DROP TRIGGER IF EXISTS agent_context_versions_preserved ON agent_context_versions;
DROP TRIGGER IF EXISTS agent_context_versions_immutable ON agent_context_versions;
DROP FUNCTION IF EXISTS cauce_runtime_grants_067();
DROP FUNCTION IF EXISTS cauce_context_history_immutable();
DELETE FROM schema_migration_ledger WHERE version='067_context_history_immutable.sql';
DELETE FROM schema_migrations WHERE version='067_context_history_immutable.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
