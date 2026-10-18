SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_085);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE provider_accounts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE provider_accounts
  DROP CONSTRAINT provider_accounts_provider_external_account_id_key,
  ADD CONSTRAINT provider_accounts_company_provider_external_account_id_key
    UNIQUE (company_id,provider,external_account_id);

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
