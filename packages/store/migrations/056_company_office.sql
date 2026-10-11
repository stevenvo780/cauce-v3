SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_056);
CREATE TABLE company_office_layouts (
  company_id text PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
  rooms jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rooms)='array'),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  updated_by uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE console_company_preferences (
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  human_id uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  pinned_quota_accounts text[] NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,human_id),
  CHECK (array_position(pinned_quota_accounts,NULL) IS NULL AND cardinality(pinned_quota_accounts)<=100)
);
CREATE FUNCTION cauce_runtime_grants_056()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_runtime_grants_056() FROM PUBLIC;
  GRANT SELECT,INSERT,UPDATE ON company_office_layouts,console_company_preferences TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_056() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_056();
