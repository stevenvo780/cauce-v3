SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_086);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE tenants,companies,console_users,agents IN SHARE ROW EXCLUSIVE MODE;

-- Permanent terminal grants administered from the console. The grants file stays a second
-- source during the transition; a session is admitted when either source grants it, so this
-- table only ever widens the file, never narrows it. Company isolation mirrors migration 053:
-- company_id is filled from the tenant, immutable, and the grantee must belong to that company.
CREATE TABLE terminal_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  grantee_human_id uuid NOT NULL,
  modes text[] NOT NULL,
  expires_at timestamptz,
  note text,
  granted_by_human_id uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_human_id uuid REFERENCES console_users(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT terminal_grants_tenant_company_fkey
    FOREIGN KEY (tenant_id,company_id) REFERENCES tenants(id,company_id) ON DELETE RESTRICT,
  CONSTRAINT terminal_grants_grantee_company_fkey
    FOREIGN KEY (grantee_human_id,company_id) REFERENCES console_users(id,company_id) ON DELETE RESTRICT,
  CONSTRAINT terminal_grants_alias_shape CHECK (alias='*' OR alias ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT terminal_grants_modes_subset CHECK (
    cardinality(modes) BETWEEN 1 AND 3
    AND modes <@ ARRAY['shell','harness','harness_rw']::text[]),
  CONSTRAINT terminal_grants_note_len CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT terminal_grants_revocation_shape CHECK (
    (revoked_at IS NULL) = (revoked_by_human_id IS NULL))
);

CREATE UNIQUE INDEX terminal_grants_active_unique
  ON terminal_grants (grantee_human_id,tenant_id,alias) WHERE revoked_at IS NULL;
CREATE INDEX terminal_grants_company_idx ON terminal_grants (company_id,tenant_id,alias,id);
CREATE INDEX terminal_grants_grantee_idx ON terminal_grants (grantee_human_id) WHERE revoked_at IS NULL;

CREATE FUNCTION cauce_terminal_grant_validate()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF cardinality(NEW.modes) <> (SELECT count(DISTINCT mode) FROM unnest(NEW.modes) AS mode) THEN
    RAISE EXCEPTION 'terminal grant modes must not repeat'
      USING ERRCODE='23514', TABLE='terminal_grants', CONSTRAINT='terminal_grants_modes_distinct';
  END IF;
  IF NEW.alias <> '*' AND NOT EXISTS (
    SELECT 1 FROM agents agent WHERE agent.tenant_id=NEW.tenant_id AND agent.alias=NEW.alias
  ) THEN
    RAISE EXCEPTION 'terminal grant target %:% does not exist',NEW.tenant_id,NEW.alias
      USING ERRCODE='23503', TABLE='terminal_grants', CONSTRAINT='terminal_grants_target_exists';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER terminal_grants_company_fill BEFORE INSERT ON terminal_grants
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company('tenant_id');
CREATE TRIGGER terminal_grants_company_immutable BEFORE UPDATE ON terminal_grants
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id)
  EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER terminal_grants_validate BEFORE INSERT OR UPDATE OF tenant_id,alias,modes ON terminal_grants
  FOR EACH ROW EXECUTE FUNCTION cauce_terminal_grant_validate();

CREATE FUNCTION cauce_runtime_grants_086()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_terminal_grant_validate(),cauce_runtime_grants_086() FROM PUBLIC;
  GRANT SELECT,INSERT,UPDATE ON terminal_grants TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_terminal_grant_validate(),cauce_runtime_grants_086() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_086();
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
