SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_096);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'096_billing.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'096_billing.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 096 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='096_billing.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='096_billing.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='096_billing.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'4a75b80a303fbcf7c9f43216c947aab7696f1485371125ea1018d800a94efb9c')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 096 from an inconsistent atomic ledger state';
  END IF;
END $$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE companies,billing_subscriptions,billing_events IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing_subscriptions WHERE status IN ('authorized','pending','paused')) THEN
    RAISE EXCEPTION 'cancel every subscription before reverting schema 096';
  END IF;
END $$;

DROP TABLE billing_events;
DROP TABLE billing_subscriptions;
ALTER TABLE companies DROP COLUMN billing_exempt;
DROP FUNCTION cauce_runtime_grants_096();

DELETE FROM schema_migration_ledger WHERE version='096_billing.sql';
DELETE FROM schema_migrations WHERE version='096_billing.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
