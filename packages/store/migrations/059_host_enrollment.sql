SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_059);
CREATE TABLE fleet_host_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  host_id text NOT NULL CHECK (host_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes)<=2000),
  invited_by uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL CHECK (nonce ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','enrolled','revoked')),
  enrolled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fleet_host_enrollments_pending_host ON fleet_host_enrollments(host_id) WHERE state='pending';
CREATE TABLE fleet_host_identities (
  host_id text PRIMARY KEY,
  company_id text NOT NULL,
  enrollment_id uuid NOT NULL UNIQUE REFERENCES fleet_host_enrollments(id) ON DELETE RESTRICT,
  public_key text NOT NULL CHECK (char_length(public_key) BETWEEN 40 AND 512),
  key_fingerprint text NOT NULL UNIQUE CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  report jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(report)='object'),
  capabilities jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(capabilities)='object'),
  capabilities_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(host_id,company_id) REFERENCES fleet_hosts(host_id,company_id) ON DELETE CASCADE
);
CREATE TABLE fleet_host_request_nonces (
  host_id text NOT NULL REFERENCES fleet_host_identities(host_id) ON DELETE CASCADE,
  nonce text NOT NULL CHECK (nonce ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(host_id,nonce)
);
CREATE FUNCTION cauce_lock_host_company(p_company text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.companies WHERE id=p_company AND enabled AND retired_at IS NULL FOR SHARE;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION cauce_lock_host_company(text) FROM PUBLIC;
CREATE FUNCTION cauce_runtime_grants_059()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_runtime_grants_059() FROM PUBLIC;
  GRANT SELECT,INSERT,UPDATE ON fleet_host_enrollments,fleet_host_identities TO cauce_runtime;
  GRANT SELECT,INSERT,DELETE ON fleet_host_request_nonces TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_lock_host_company(text) TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_059() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_059();
