SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_059);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM fleet_host_identities) OR EXISTS(SELECT 1 FROM fleet_host_enrollments) THEN
    RAISE EXCEPTION 'export and revoke host identities before reverting';
  END IF;
END $$;
DROP FUNCTION cauce_runtime_grants_059();
DROP FUNCTION cauce_lock_host_company(text);
DROP TABLE fleet_host_request_nonces;
DROP TABLE fleet_host_identities;
DROP TABLE fleet_host_enrollments;
