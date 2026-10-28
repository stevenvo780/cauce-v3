SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_097);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE billing_subscriptions IN ACCESS EXCLUSIVE MODE;

-- A coupon takes a percentage off every monthly charge of the subscription that redeems it. Codes are
-- issued by the platform operator; a redemption counts when the checkout commits.
CREATE TABLE billing_coupons (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
  percent_off integer NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  max_redemptions integer CHECK (max_redemptions IS NULL OR max_redemptions >= 1),
  redemptions integer NOT NULL DEFAULT 0
    CHECK (redemptions >= 0 AND (max_redemptions IS NULL OR redemptions <= max_redemptions)),
  expires_at timestamptz,
  note text CHECK (note IS NULL OR length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE billing_subscriptions
  ADD COLUMN coupon_code text REFERENCES billing_coupons(code) ON DELETE RESTRICT,
  ADD COLUMN percent_off integer CHECK (percent_off IS NULL OR percent_off BETWEEN 1 AND 90),
  ADD CONSTRAINT billing_subscriptions_coupon_pair CHECK ((coupon_code IS NULL) = (percent_off IS NULL));

CREATE FUNCTION cauce_runtime_grants_097() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  GRANT SELECT,UPDATE ON billing_coupons TO cauce_runtime;
  REVOKE ALL ON FUNCTION cauce_runtime_grants_097() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_097() TO cauce_platform;
END $$;
SELECT cauce_runtime_grants_097();
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
