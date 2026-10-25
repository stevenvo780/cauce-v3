SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_090);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);

CREATE FUNCTION cauce_runtime_grants_090()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  ALTER FUNCTION public.cauce_platform_write_guard() SET search_path=pg_catalog,public,pg_temp;
  REVOKE ALL ON FUNCTION cauce_runtime_grants_090() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_090() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_090();

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
