SELECT pg_advisory_xact_lock(783_003_062);
CREATE FUNCTION cauce_lock_authority_read_guard()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.platform_admins admin ORDER BY admin.human_id FOR SHARE OF admin;
END
$$;
CREATE FUNCTION cauce_runtime_grants_062()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_lock_authority_read_guard(),cauce_runtime_grants_062() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_lock_authority_read_guard() TO cauce_runtime,cauce_platform;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_062() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_062();
