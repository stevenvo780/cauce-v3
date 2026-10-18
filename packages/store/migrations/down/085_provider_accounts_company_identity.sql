SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_085);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'085_provider_accounts_company_identity.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'085_provider_accounts_company_identity.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 085 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='085_provider_accounts_company_identity.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='085_provider_accounts_company_identity.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='085_provider_accounts_company_identity.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'72e38d0af7d1259e34074874de38e7e57eaf68e6644173c9d388b61e326c527a')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 085 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE provider_accounts IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM provider_accounts GROUP BY provider,external_account_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'cannot downgrade schema 085 while provider accounts share an identity across companies';
  END IF;
END
$$;

ALTER TABLE provider_accounts
  DROP CONSTRAINT provider_accounts_company_provider_external_account_id_key,
  ADD CONSTRAINT provider_accounts_provider_external_account_id_key UNIQUE (provider,external_account_id);

DELETE FROM schema_migration_ledger WHERE version='085_provider_accounts_company_identity.sql';
DELETE FROM schema_migrations WHERE version='085_provider_accounts_company_identity.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
