SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_067);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE agent_context_versions IN SHARE ROW EXCLUSIVE MODE;

-- A context version is history: a change or a restore writes a new version. No documented purge removes
-- versions, so the owner and the platform are refused as well. TRUNCATE passes only on an empty table,
-- because truncating console_users with CASCADE reaches it through actor_human_id.
CREATE FUNCTION cauce_context_history_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM agent_context_versions) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'context history is immutable; write a new version instead' USING ERRCODE='55000';
END
$$;
CREATE TRIGGER agent_context_versions_immutable BEFORE UPDATE OR DELETE ON agent_context_versions
  FOR EACH ROW EXECUTE FUNCTION cauce_context_history_immutable();
CREATE TRIGGER agent_context_versions_preserved BEFORE TRUNCATE ON agent_context_versions
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_context_history_immutable();

CREATE FUNCTION cauce_runtime_grants_067()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_context_history_immutable(),cauce_runtime_grants_067() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_context_history_immutable(),cauce_runtime_grants_067() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_067();
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
