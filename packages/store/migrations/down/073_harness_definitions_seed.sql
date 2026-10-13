SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_073);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'073_harness_definitions_seed.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'073_harness_definitions_seed.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 073 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='073_harness_definitions_seed.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='073_harness_definitions_seed.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='073_harness_definitions_seed.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'4364459ab5b0cf8c125a339a1ae66834c0ccf79ae9943ef1e4a17ea2d4096094')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 073 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
DELETE FROM harness_definitions WHERE id IN ('grok','muse','fake2')
  AND created_at=(SELECT applied_at FROM schema_migrations WHERE version='073_harness_definitions_seed.sql')
  AND NOT EXISTS (SELECT 1 FROM agents WHERE harness_id=harness_definitions.id);
DELETE FROM schema_migration_ledger WHERE version='073_harness_definitions_seed.sql';
DELETE FROM schema_migrations WHERE version='073_harness_definitions_seed.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
