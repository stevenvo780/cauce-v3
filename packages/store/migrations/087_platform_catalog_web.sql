SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_087);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);

-- The web catalog writes through the same store path as the platform CLI. The runtime login
-- still cannot write these tables on its own: the guard only passes when the transaction
-- carries the platform-catalog flag, which the store sets after asserting platform
-- administrator authority in that same transaction. Audit rewrites keep requiring
-- membership of the platform role.
CREATE FUNCTION cauce_runtime_grants_087()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  GRANT INSERT, DELETE ON harness_definitions, role_policies TO cauce_runtime;
  REVOKE ALL ON FUNCTION cauce_runtime_grants_087() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_087() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_087();

CREATE OR REPLACE FUNCTION cauce_platform_write_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME IN ('harness_definitions','role_policies')
    AND current_setting('cauce.platform_catalog_write',true)='on' THEN
    RETURN NULL;
  END IF;
  IF NOT pg_has_role(current_user,'cauce_platform','MEMBER') THEN
    RAISE EXCEPTION '% on % requires the cauce_platform role',TG_OP,TG_TABLE_NAME USING ERRCODE='42501';
  END IF;
  RETURN NULL;
END
$$;

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
