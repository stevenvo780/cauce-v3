SELECT pg_advisory_xact_lock(783_003_061);
CREATE FUNCTION cauce_human_has_admin_history(p_human uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.company_admin_versions history WHERE history.human_id=p_human)
$$;
CREATE FUNCTION cauce_runtime_grants_061()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_human_has_admin_history(uuid),cauce_runtime_grants_061() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_human_has_admin_history(uuid) TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_061() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_061();
