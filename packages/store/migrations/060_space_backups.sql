SELECT pg_advisory_xact_lock(783_003_060);
CREATE TABLE space_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  host_id text NOT NULL,
  requested_by uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  agent_snapshot jsonb NOT NULL CHECK (jsonb_typeof(agent_snapshot)='object'),
  policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ready','failed')),
  error text CHECK (error IN ('HOST_UNAVAILABLE','SCOPE_CHANGED','EXPORT_FAILED','EXPIRED','LIMIT_EXCEEDED')),
  claim_token uuid,
  claim_epoch integer NOT NULL DEFAULT 0 CHECK (claim_epoch>=0),
  lease_until timestamptz,
  received_bytes integer NOT NULL DEFAULT 0 CHECK (received_bytes BETWEEN 0 AND 33554432),
  bytes integer CHECK (bytes BETWEEN 1 AND 33554432),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  FOREIGN KEY(tenant_id,alias) REFERENCES agents(tenant_id,alias) ON DELETE RESTRICT,
  FOREIGN KEY(host_id,company_id) REFERENCES fleet_hosts(host_id,company_id) ON DELETE RESTRICT,
  UNIQUE(company_id,tenant_id,alias,idempotency_key),
  CHECK (status<>'ready' OR (bytes IS NOT NULL AND sha256 IS NOT NULL AND manifest_sha256 IS NOT NULL AND received_bytes=bytes))
);
CREATE INDEX space_backups_queue ON space_backups(host_id,created_at) WHERE status IN ('pending','running');
CREATE FUNCTION cauce_runtime_grants_060()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_runtime_grants_060() FROM PUBLIC;
  GRANT SELECT,INSERT,UPDATE,DELETE ON space_backups TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_060() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_060();
