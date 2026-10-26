SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_093);

-- A console session is a signed cookie whose expiry slides while it is used. Closing it has to
-- outlive the cookie the browser forgets, so the session id is recorded until the day its
-- absolute ceiling would have ended it anyway.
CREATE TABLE console_session_revocations (
  sid text PRIMARY KEY CHECK (char_length(sid) BETWEEN 16 AND 128),
  human_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  not_after timestamptz NOT NULL
);
CREATE INDEX console_session_revocations_not_after ON console_session_revocations(not_after);

CREATE FUNCTION cauce_runtime_grants_093() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  GRANT SELECT,INSERT,DELETE ON console_session_revocations TO cauce_runtime;
  REVOKE ALL ON FUNCTION cauce_runtime_grants_093() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_093() TO cauce_platform;
END $$;
SELECT cauce_runtime_grants_093();
