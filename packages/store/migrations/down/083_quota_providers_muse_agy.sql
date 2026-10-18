SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_083);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'083_quota_providers_muse_agy.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'083_quota_providers_muse_agy.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 083 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='083_quota_providers_muse_agy.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='083_quota_providers_muse_agy.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='083_quota_providers_muse_agy.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'53018fefa54a6f2fb80672c916a28b9fc2e028071daa2182da102ca3883bfa62'))
    OR (NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='083_quota_providers_muse_agy.sql')
      AND EXISTS (SELECT 1 FROM quota_environments WHERE provider IN ('muse','agy'))) THEN
    RAISE EXCEPTION 'cannot downgrade schema 083 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE quota_environments IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM quota_environments WHERE provider IN ('muse','agy')) THEN
    RAISE EXCEPTION 'export quota environments before reverting providers muse and agy';
  END IF;
END
$$;

ALTER TABLE quota_environments DROP CONSTRAINT quota_environments_provider_check;
ALTER TABLE quota_environments ADD CONSTRAINT quota_environments_provider_check
  CHECK (provider IN ('claude','codex','gemini','grok'));

DELETE FROM schema_migration_ledger WHERE version='083_quota_providers_muse_agy.sql';
DELETE FROM schema_migrations WHERE version='083_quota_providers_muse_agy.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
