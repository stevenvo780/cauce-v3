SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_080);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE agents IN SHARE ROW EXCLUSIVE MODE;

-- The alias keys the context history and the Git folder of an agent: renaming it would orphan both.
-- Display name and room stay editable; recreating an alias keeps its history by design.
CREATE FUNCTION cauce_agents_alias_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'agents.alias is immutable'
    USING ERRCODE='23514', TABLE='agents', COLUMN='alias', CONSTRAINT='agents_alias_immutable';
END
$$;
CREATE TRIGGER agents_alias_immutable BEFORE UPDATE ON agents
  FOR EACH ROW WHEN (OLD.alias IS DISTINCT FROM NEW.alias) EXECUTE FUNCTION cauce_agents_alias_immutable();

CREATE FUNCTION cauce_runtime_grants_080()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_agents_alias_immutable(),cauce_runtime_grants_080() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_agents_alias_immutable(),cauce_runtime_grants_080() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_080();
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
