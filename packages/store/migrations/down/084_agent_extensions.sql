SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_084);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'084_agent_extensions.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'084_agent_extensions.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 084 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='084_agent_extensions.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='084_agent_extensions.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='084_agent_extensions.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'2ae0e4d11831daa190cdcb36d02a7c717be604811702578b172d931861949af5')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 084 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE agents,fleet_hosts IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents WHERE extensions<>'[]'::jsonb)
    OR EXISTS (SELECT 1 FROM fleet_hosts WHERE extensions_allowed<>'{"types":[],"mount_roots":[],"networks":[]}'::jsonb) THEN
    RAISE EXCEPTION 'remove agent extensions and host permissions before reverting schema 084';
  END IF;
END
$$;

ALTER TABLE agents DROP COLUMN extensions;
ALTER TABLE fleet_hosts DROP COLUMN extensions_allowed;

DELETE FROM schema_migration_ledger WHERE version='084_agent_extensions.sql';
DELETE FROM schema_migrations WHERE version='084_agent_extensions.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
