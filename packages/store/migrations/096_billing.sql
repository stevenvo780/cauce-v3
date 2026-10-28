SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_096);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE companies IN ACCESS EXCLUSIVE MODE;

-- Every company that exists when billing arrives keeps working unpaid; only companies created
-- afterwards start non-exempt. The column is added with default true so existing rows take true
-- without an UPDATE, then the default flips for future rows.
ALTER TABLE companies ADD COLUMN billing_exempt boolean NOT NULL DEFAULT true;
ALTER TABLE companies ALTER COLUMN billing_exempt SET DEFAULT false;

CREATE TABLE billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  plan text NOT NULL CHECK (plan IN ('gestionado','hotel_20','hotel_50','espacio')),
  quantity integer NOT NULL CHECK (quantity >= 1),
  agent_limit integer NOT NULL CHECK (agent_limit >= 1),
  amount_usd numeric(10,2) NOT NULL CHECK (amount_usd > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_local numeric(14,2) NOT NULL CHECK (amount_local > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','paused','cancelled')),
  provider text NOT NULL DEFAULT 'mercadopago',
  provider_subscription_id text UNIQUE,
  checkout_url text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz
);
CREATE UNIQUE INDEX billing_subscriptions_live_unique
  ON billing_subscriptions (company_id) WHERE status IN ('authorized','pending');
CREATE INDEX billing_subscriptions_company_idx ON billing_subscriptions (company_id,created_at DESC);

CREATE TABLE billing_events (
  id bigserial PRIMARY KEY,
  provider_event_id text NOT NULL,
  request_id text,
  topic text NOT NULL,
  subscription_id uuid REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_events_idempotency UNIQUE (provider_event_id,topic)
);
CREATE INDEX billing_events_subscription_idx ON billing_events (subscription_id) WHERE subscription_id IS NOT NULL;

CREATE FUNCTION cauce_runtime_grants_096() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  GRANT SELECT,INSERT,UPDATE ON billing_subscriptions TO cauce_runtime;
  GRANT SELECT,INSERT ON billing_events TO cauce_runtime;
  GRANT USAGE,SELECT ON SEQUENCE billing_events_id_seq TO cauce_runtime;
  REVOKE ALL ON FUNCTION cauce_runtime_grants_096() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_096() TO cauce_platform;
END $$;
SELECT cauce_runtime_grants_096();
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
