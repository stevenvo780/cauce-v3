SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_086);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'086_runtime_lease_identity.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'086_runtime_lease_identity.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 086 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='086_runtime_lease_identity.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='086_runtime_lease_identity.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='086_runtime_lease_identity.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'351a0143caa3ce69f1e3aabcccbb02b17cb4737828873a204af286c21e358bb4')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 086 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE agents IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents WHERE runtime_certificate_sha256 IS NOT NULL) THEN
    RAISE EXCEPTION 'export runtime certificate bindings before reverting schema 086';
  END IF;
END
$$;

ALTER TABLE agents
  DROP CONSTRAINT agents_runtime_certificate_identity,
  DROP COLUMN runtime_certificate_sha256,
  DROP COLUMN runtime_certificate_host_id,
  DROP COLUMN runtime_certificate_expires_at;

DELETE FROM schema_migration_ledger WHERE version='086_runtime_lease_identity.sql';
DELETE FROM schema_migrations WHERE version='086_runtime_lease_identity.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
