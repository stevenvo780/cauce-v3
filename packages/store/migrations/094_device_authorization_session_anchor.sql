SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_094);

-- The console session that approves a device login anchors its absolute ceiling at its own login
-- instant. The session the device receives inherits that instant, so approving devices in a chain
-- never buys a fresh ceiling.
ALTER TABLE device_authorizations ADD COLUMN session_auth_at timestamptz;
ALTER TABLE device_authorizations ADD CONSTRAINT device_authorizations_session_auth_at_decided
  CHECK (session_auth_at IS NULL OR decided_at IS NOT NULL);

CREATE FUNCTION cauce_device_authorization_session_anchor() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.decided_at IS NOT NULL AND NEW.session_auth_at IS DISTINCT FROM OLD.session_auth_at THEN
    RAISE EXCEPTION 'device authorization session anchor is immutable once decided';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_authorization_session_anchor BEFORE UPDATE ON device_authorizations
  FOR EACH ROW EXECUTE FUNCTION cauce_device_authorization_session_anchor();

CREATE FUNCTION cauce_runtime_grants_094() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_device_authorization_session_anchor(),cauce_runtime_grants_094() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_device_authorization_session_anchor(),cauce_runtime_grants_094() TO cauce_platform;
END $$;
SELECT cauce_runtime_grants_094();
