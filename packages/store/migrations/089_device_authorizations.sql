SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_089);

CREATE TABLE device_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE CHECK (device_code_hash ~ '^[a-f0-9]{64}$'),
  user_code_hash text NOT NULL UNIQUE CHECK (user_code_hash ~ '^[a-f0-9]{64}$'),
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 120),
  masked_ip text NOT NULL CHECK (char_length(masked_ip) BETWEEN 1 AND 80),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','consumed','expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
  poll_interval integer NOT NULL DEFAULT 5 CHECK (poll_interval BETWEEN 5 AND 2147483642),
  next_poll_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 seconds',
  human_id uuid REFERENCES console_users(id) ON DELETE RESTRICT,
  tenant_id text,
  actor_alias text,
  active_company text CHECK (active_company ~ '^[a-z][a-z0-9_-]{0,63}$'),
  credential_stamp text CHECK (credential_stamp ~ '^[A-Za-z0-9_-]{43}$'),
  membership_revision bigint CHECK (membership_revision>0),
  membership_snapshot text CHECK (membership_snapshot ~ '^[0-9]{1,10}$'),
  decided_at timestamptz,
  consumed_at timestamptz,
  FOREIGN KEY (tenant_id,actor_alias) REFERENCES agents(tenant_id,alias) ON DELETE RESTRICT,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '601 seconds'),
  CHECK ((decided_at IS NULL AND human_id IS NULL AND tenant_id IS NULL AND actor_alias IS NULL
    AND active_company IS NULL AND credential_stamp IS NULL AND membership_revision IS NULL AND membership_snapshot IS NULL
    AND state IN ('pending','expired')) OR
    (decided_at IS NOT NULL AND human_id IS NOT NULL AND tenant_id IS NOT NULL AND actor_alias IS NOT NULL
    AND active_company IS NOT NULL AND credential_stamp IS NOT NULL AND membership_revision IS NOT NULL AND membership_snapshot IS NOT NULL
    AND state IN ('approved','denied','consumed','expired'))),
  CHECK ((state='consumed')=(consumed_at IS NOT NULL)),
  CHECK (decided_at IS NULL OR (decided_at>=created_at AND decided_at<expires_at)),
  CHECK (consumed_at IS NULL OR (consumed_at>=decided_at AND consumed_at<expires_at))
);
CREATE INDEX device_authorizations_expiry ON device_authorizations(expires_at) WHERE state IN ('pending','approved');

CREATE FUNCTION cauce_device_authorization_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.id,NEW.device_code_hash,NEW.user_code_hash,NEW.client_name,NEW.masked_ip,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM
      (OLD.id,OLD.device_code_hash,OLD.user_code_hash,OLD.client_name,OLD.masked_ip,OLD.created_at,OLD.expires_at)
    OR (OLD.decided_at IS NOT NULL AND
      (NEW.human_id,NEW.tenant_id,NEW.actor_alias,NEW.active_company,NEW.credential_stamp,NEW.membership_revision,NEW.membership_snapshot,NEW.decided_at)
      IS DISTINCT FROM
      (OLD.human_id,OLD.tenant_id,OLD.actor_alias,OLD.active_company,OLD.credential_stamp,OLD.membership_revision,OLD.membership_snapshot,OLD.decided_at))
    OR (NEW.state<>OLD.state AND NOT
      ((OLD.state='pending' AND NEW.state IN ('approved','denied','expired')) OR
       (OLD.state='approved' AND NEW.state IN ('consumed','denied','expired'))))
    OR NEW.poll_interval<OLD.poll_interval THEN
    RAISE EXCEPTION 'device authorization identity and terminal transitions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_authorization_transition BEFORE UPDATE ON device_authorizations
  FOR EACH ROW EXECUTE FUNCTION cauce_device_authorization_transition();
CREATE TRIGGER console_users_device_authority_revision AFTER UPDATE OF active ON console_users
  FOR EACH ROW WHEN (NEW.active IS DISTINCT FROM OLD.active) EXECUTE FUNCTION cauce_console_user_role_revision();

CREATE FUNCTION cauce_runtime_grants_089() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  GRANT SELECT,INSERT,UPDATE ON device_authorizations TO cauce_runtime;
  REVOKE ALL ON FUNCTION cauce_device_authorization_transition(),cauce_runtime_grants_089() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_device_authorization_transition(),cauce_runtime_grants_089() TO cauce_platform;
END $$;
SELECT cauce_runtime_grants_089();
