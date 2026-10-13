SELECT pg_advisory_xact_lock(783_003_070);
CREATE TABLE agent_quota_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  host_id text NOT NULL,
  requested_by uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  expected_revision bigint NOT NULL CHECK (expected_revision>=0),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  agent_snapshot jsonb NOT NULL CHECK (jsonb_typeof(agent_snapshot)='object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  claim_token uuid,
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch>=0),
  worker_id text,
  lease_until timestamptz,
  receipt jsonb CHECK (receipt IS NULL OR jsonb_typeof(receipt)='object'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  error_code text CHECK (error_code IN ('PROVIDER_UNAVAILABLE','RUNTIME_UNAVAILABLE','STEP_FAILED','AUTHORITY_REVOKED','SCOPE_CHANGED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,company_id) REFERENCES tenants(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,alias) REFERENCES agents(tenant_id,alias) ON DELETE RESTRICT,
  FOREIGN KEY(host_id,company_id) REFERENCES fleet_hosts(host_id,company_id) ON DELETE RESTRICT,
  UNIQUE(company_id,idempotency_key),
  CHECK (status<>'running' OR (claim_token IS NOT NULL AND worker_id IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status<>'done' OR (receipt IS NOT NULL AND result IS NOT NULL))
);
CREATE UNIQUE INDEX agent_quota_operations_active_target ON agent_quota_operations(tenant_id,alias)
  WHERE status IN ('pending','running');
CREATE INDEX agent_quota_operations_queue ON agent_quota_operations(host_id,company_id,created_at,id)
  WHERE status IN ('pending','running');
CREATE TABLE agent_quota_observations (
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  agent_snapshot jsonb NOT NULL CHECK (jsonb_typeof(agent_snapshot)='object'),
  reader_available boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('unsupported','ok','error')),
  captured_at timestamptz,
  account_id text,
  sample jsonb CHECK (sample IS NULL OR jsonb_typeof(sample)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,alias),
  FOREIGN KEY(tenant_id,company_id) REFERENCES tenants(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,alias) REFERENCES agents(tenant_id,alias) ON DELETE RESTRICT,
  CHECK (status<>'unsupported' OR (NOT reader_available AND account_id IS NULL AND sample IS NULL))
);
CREATE FUNCTION cauce_runtime_grants_070()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_runtime_grants_070() FROM PUBLIC;
  GRANT SELECT,INSERT,UPDATE,DELETE ON agent_quota_operations,agent_quota_observations TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_070() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_070();
