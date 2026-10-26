SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_095);

-- Purging a retired agent deletes its permanent terminal grants (PURGE_CONFIGURATION), and the
-- gateway runs as cauce_runtime. Migration 086 granted SELECT,INSERT,UPDATE only, so the purge
-- failed with "permission denied for table terminal_grants". The grant is not widened beyond
-- DELETE: revocation stays a soft revoke through UPDATE, and no trigger or constraint changes.
CREATE FUNCTION cauce_runtime_grants_095() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  GRANT DELETE ON terminal_grants TO cauce_runtime;
  REVOKE ALL ON FUNCTION cauce_runtime_grants_095() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_095() TO cauce_platform;
END $$;
SELECT cauce_runtime_grants_095();
