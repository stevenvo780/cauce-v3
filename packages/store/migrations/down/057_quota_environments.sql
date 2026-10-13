SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout',(SELECT LEAST(NULLIF(setting::integer,0),5000)::text||'ms'
  FROM pg_settings WHERE name='lock_timeout'),true);
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_057);
DO $$ BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'057_quota_environments.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'057_quota_environments.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 057 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='057_quota_environments.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='057_quota_environments.sql')
    OR (to_regclass('public.quota_environments') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='057_quota_environments.sql'))
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='057_quota_environments.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'182571e43860f5399d2db63729e5312587b8cb2a23173aa2d8a0f72c25eb410f')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 057 from an inconsistent atomic ledger state';
  END IF;
END $$;
LOCK TABLE provider_accounts,quota_window_state,quota_provider_reports,quota_window_samples,
  quota_environments,quota_environment_operations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM quota_environments) OR EXISTS (SELECT 1 FROM provider_accounts WHERE quota_registration_key IS NOT NULL)
    OR EXISTS (SELECT 1 FROM provider_accounts WHERE quota_identity_hash IS NOT NULL OR canonical_account_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM quota_provider_reports WHERE account_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM quota_window_samples GROUP BY collection_id,provider,group_key,window_key HAVING count(*)>1)
    OR EXISTS (SELECT 1 FROM quota_window_state GROUP BY collector_tenant,host,provider,group_key,window_key HAVING count(*)>1)
    OR EXISTS (SELECT 1 FROM quota_window_samples WHERE num_nonnulls(used_percent,remaining_percent,used_units)=0) THEN
    RAISE EXCEPTION 'quota environments or richer observations must be exported before rollback';
  END IF;
END $$;
DROP TABLE quota_environment_operations;
DROP TABLE quota_environments;
DROP FUNCTION cauce_runtime_grants_057();
DROP TRIGGER quota_provider_report_account_guard ON quota_provider_reports;
DROP FUNCTION cauce_quota_report_account_guard();
ALTER TABLE quota_provider_reports DROP COLUMN account_id;
ALTER TABLE quota_window_state DROP CONSTRAINT quota_window_state_pkey;
ALTER TABLE quota_window_state DROP COLUMN model_key;
ALTER TABLE quota_window_state DROP COLUMN account_key;
ALTER TABLE quota_window_state ADD PRIMARY KEY (collector_tenant,host,provider,group_key,window_key);
ALTER TABLE quota_window_samples DROP CONSTRAINT quota_window_samples_pkey;
ALTER TABLE quota_window_samples DROP COLUMN model_key;
ALTER TABLE quota_window_samples DROP COLUMN account_key;
ALTER TABLE quota_window_samples ADD PRIMARY KEY (collection_id,provider,group_key,window_key);
ALTER TABLE quota_window_samples DROP CONSTRAINT quota_window_samples_has_observation;
ALTER TABLE quota_window_samples ADD CONSTRAINT quota_window_samples_has_a_number
  CHECK (num_nonnulls(used_percent,remaining_percent,used_units)>0);
DROP INDEX provider_accounts_quota_registration_key;
ALTER TABLE provider_accounts DROP COLUMN quota_registration_key;
ALTER TABLE provider_accounts DROP COLUMN quota_version;
DROP INDEX provider_accounts_quota_identity;
ALTER TABLE provider_accounts DROP COLUMN canonical_account_id;
ALTER TABLE provider_accounts DROP COLUMN quota_identity_hash;
DELETE FROM schema_migration_ledger WHERE version='057_quota_environments.sql';
DELETE FROM schema_migrations WHERE version='057_quota_environments.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
