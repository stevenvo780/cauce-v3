SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_058);
DO $$ BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'058_context_versions.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'058_context_versions.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 058 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='058_context_versions.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='058_context_versions.sql')
    OR (to_regclass('public.agent_context_versions') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='058_context_versions.sql'))
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='058_context_versions.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'398331de5eef471293ace9ab0d7e7291288e0a36cee05b0f7654cc715c565637')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 058 from an inconsistent atomic ledger state';
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
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
