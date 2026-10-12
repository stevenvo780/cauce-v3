SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_065);

CREATE FUNCTION cauce_runtime_grants_065()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_quota_report_account_guard(),cauce_lock_host_company(text),
    cauce_runtime_grants_065() FROM PUBLIC;
  REVOKE ALL ON FUNCTION cauce_ensure_context_director_anchor(text,text,text,bigint,text)
    FROM PUBLIC,cauce_runtime,cauce_observer;
  GRANT EXECUTE ON FUNCTION cauce_ensure_context_director_anchor(text,text,text,bigint,text)
    TO cauce_runtime,cauce_platform;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_065() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_065();
