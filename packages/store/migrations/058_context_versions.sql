SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_058);
ALTER TABLE deliveries ADD COLUMN context_version bigint CHECK (context_version>0);
ALTER TABLE deliveries ADD COLUMN context_digest text CHECK (context_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE deliveries ADD CONSTRAINT deliveries_context_expected_pair CHECK ((context_version IS NULL)=(context_digest IS NULL));
CREATE TABLE agent_context_versions (
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  version bigint NOT NULL CHECK (version>0),
  files jsonb NOT NULL CHECK (jsonb_typeof(files)='array'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  source text NOT NULL CHECK (source IN ('ui','cli','native','restore','profile','directive')),
  restored_from bigint,
  actor_human_id uuid REFERENCES console_users(id) ON DELETE RESTRICT,
  actor_alias text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id,tenant_id,alias,version),
  CHECK (restored_from IS NULL OR (source='restore' AND restored_from>0 AND restored_from<version))
);
CREATE TABLE agent_context_state (
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  desired_version bigint NOT NULL DEFAULT 0 CHECK (desired_version>=0),
  applied_version bigint NOT NULL DEFAULT 0 CHECK (applied_version>=0 AND applied_version<=desired_version),
  applied_digest text CHECK (applied_digest ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz,
  PRIMARY KEY (company_id,tenant_id,alias),
  FOREIGN KEY (tenant_id,alias) REFERENCES agents(tenant_id,alias) ON DELETE CASCADE
);
CREATE TABLE agent_context_outbox (
  company_id text NOT NULL,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  version bigint NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','synced','error')),
  git_commit text CHECK (git_commit ~ '^[a-f0-9]{40,64}$'),
  applied_at timestamptz,
  pushed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  apply_error text,
  apply_retry_at timestamptz NOT NULL DEFAULT now(),
  apply_token uuid,
  apply_lease_until timestamptz,
  CHECK ((apply_token IS NULL)=(apply_lease_until IS NULL)),
  PRIMARY KEY (company_id,tenant_id,alias,version),
  FOREIGN KEY (company_id,tenant_id,alias,version) REFERENCES agent_context_versions ON DELETE RESTRICT,
  FOREIGN KEY (company_id,tenant_id,alias) REFERENCES agent_context_state ON DELETE CASCADE
);
CREATE INDEX agent_context_outbox_ready ON agent_context_outbox(retry_at) WHERE state<>'synced';
CREATE FUNCTION cauce_context_company() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id=NEW.tenant_id AND company_id=NEW.company_id) THEN
    RAISE EXCEPTION 'context company differs from its tenant' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agent_context_versions_company BEFORE INSERT OR UPDATE ON agent_context_versions
  FOR EACH ROW EXECUTE FUNCTION cauce_context_company();
CREATE TRIGGER agent_context_state_company BEFORE INSERT OR UPDATE ON agent_context_state
  FOR EACH ROW EXECUTE FUNCTION cauce_context_company();
CREATE FUNCTION cauce_runtime_grants_058() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_runtime_grants_058(),cauce_context_company() FROM PUBLIC;
  GRANT SELECT,INSERT ON agent_context_versions TO cauce_runtime;
  GRANT SELECT,INSERT,UPDATE,DELETE ON agent_context_state,agent_context_outbox TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_058() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_058();
