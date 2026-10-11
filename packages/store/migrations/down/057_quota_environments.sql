SELECT pg_advisory_xact_lock(783_003_003);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM quota_environments) OR EXISTS (SELECT 1 FROM provider_accounts WHERE quota_registration_key IS NOT NULL)
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
