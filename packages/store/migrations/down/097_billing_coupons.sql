SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_097);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'097_billing_coupons.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'097_billing_coupons.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 097 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='097_billing_coupons.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='097_billing_coupons.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='097_billing_coupons.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'2940f9ca88d5ba984ad7e3209b4a5e5f8c841e02848a747ff08b8510d593c404')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 097 from an inconsistent atomic ledger state';
  END IF;
END $$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE billing_subscriptions,billing_coupons IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing_subscriptions WHERE coupon_code IS NOT NULL AND status IN ('authorized','pending','paused')) THEN
    RAISE EXCEPTION 'cancel every discounted subscription before reverting schema 097';
  END IF;
END $$;

ALTER TABLE billing_subscriptions DROP CONSTRAINT billing_subscriptions_coupon_pair,
  DROP COLUMN percent_off, DROP COLUMN coupon_code;
DROP TABLE billing_coupons;
DROP FUNCTION cauce_runtime_grants_097();

DELETE FROM schema_migration_ledger WHERE version='097_billing_coupons.sql';
DELETE FROM schema_migrations WHERE version='097_billing_coupons.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
