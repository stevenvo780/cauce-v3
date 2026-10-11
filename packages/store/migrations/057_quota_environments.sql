SELECT pg_advisory_xact_lock(783_003_003);
ALTER TABLE provider_accounts ADD COLUMN quota_registration_key text;
ALTER TABLE provider_accounts ADD COLUMN quota_version bigint NOT NULL DEFAULT 1 CHECK (quota_version>0);
ALTER TABLE provider_accounts ADD COLUMN quota_identity_hash text CHECK (quota_identity_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE provider_accounts ADD COLUMN canonical_account_id text;
ALTER TABLE provider_accounts ADD CONSTRAINT provider_accounts_quota_canonical_company
  FOREIGN KEY (canonical_account_id,company_id) REFERENCES provider_accounts(id,company_id);
CREATE UNIQUE INDEX provider_accounts_quota_identity ON provider_accounts(company_id,provider,quota_identity_hash)
  WHERE quota_identity_hash IS NOT NULL;
CREATE UNIQUE INDEX provider_accounts_quota_registration_key ON provider_accounts(company_id,quota_registration_key)
  WHERE quota_registration_key IS NOT NULL;
ALTER TABLE quota_provider_reports ADD COLUMN account_id text REFERENCES provider_accounts(id) ON DELETE RESTRICT;
CREATE FUNCTION cauce_quota_report_account_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_collections collection
    JOIN tenants collector ON collector.id=collection.collector_tenant
    JOIN provider_accounts account ON account.company_id=collector.company_id
    WHERE collection.id=NEW.collection_id AND account.id=NEW.account_id AND account.provider=NEW.provider) THEN
    RAISE EXCEPTION 'quota report account belongs to another company or provider' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cauce_quota_report_account_guard() FROM PUBLIC;
CREATE TRIGGER quota_provider_report_account_guard BEFORE INSERT OR UPDATE OF account_id,collection_id,provider ON quota_provider_reports
  FOR EACH ROW EXECUTE FUNCTION cauce_quota_report_account_guard();
ALTER TABLE quota_window_state ADD COLUMN model_key text GENERATED ALWAYS AS (COALESCE(model,'')) STORED;
ALTER TABLE quota_window_samples ADD COLUMN model_key text GENERATED ALWAYS AS (COALESCE(model,'')) STORED;
ALTER TABLE quota_window_state ADD COLUMN account_key text GENERATED ALWAYS AS (COALESCE(account_id,'')) STORED;
ALTER TABLE quota_window_samples ADD COLUMN account_key text GENERATED ALWAYS AS (COALESCE(account_id,'')) STORED;
ALTER TABLE quota_window_state DROP CONSTRAINT quota_window_state_pkey;
ALTER TABLE quota_window_state ADD PRIMARY KEY (collector_tenant,host,provider,group_key,window_key,model_key,account_key);
ALTER TABLE quota_window_samples DROP CONSTRAINT quota_window_samples_pkey;
ALTER TABLE quota_window_samples ADD PRIMARY KEY (collection_id,provider,group_key,window_key,model_key,account_key);
ALTER TABLE quota_window_samples DROP CONSTRAINT quota_window_samples_has_a_number;
ALTER TABLE quota_window_samples ADD CONSTRAINT quota_window_samples_has_observation
  CHECK (num_nonnulls(used_percent,remaining_percent,used_units)>0 OR status IN ('unknown','error'));

CREATE TABLE quota_environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  account_id text NOT NULL,
  host_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('claude','codex','gemini','grok')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  container_name text NOT NULL UNIQUE CHECK (container_name ~ '^cauce-quota-[a-f0-9]{32}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ready','awaiting_auth','failed','deleting','deleted')),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  idempotency_key text NOT NULL,
  created_by uuid NOT NULL REFERENCES console_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id,company_id) REFERENCES provider_accounts(id,company_id),
  FOREIGN KEY (host_id,company_id) REFERENCES fleet_hosts(host_id,company_id),
  UNIQUE (company_id,idempotency_key),
  UNIQUE (id,company_id)
);
CREATE TABLE quota_environment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL,
  company_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create','authenticate','query','update_cli','delete')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','awaiting_auth','done','failed')),
  idempotency_key text NOT NULL,
  requested_by uuid NOT NULL REFERENCES console_users(id),
  consent boolean NOT NULL DEFAULT false,
  claim_token uuid,
  claim_epoch bigint NOT NULL DEFAULT 0,
  worker_id text,
  lease_until timestamptz,
  error_code text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id,company_id) REFERENCES quota_environments(id,company_id),
  UNIQUE (company_id,idempotency_key),
  CHECK (action<>'authenticate' OR consent)
);
CREATE UNIQUE INDEX quota_environment_operations_one_active ON quota_environment_operations(environment_id)
  WHERE status IN ('pending','running','awaiting_auth');
CREATE INDEX quota_environment_operations_pending ON quota_environment_operations(created_at)
  WHERE status IN ('pending','running');
CREATE FUNCTION cauce_runtime_grants_057()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_runtime_grants_057() FROM PUBLIC;
  GRANT SELECT,INSERT,UPDATE,DELETE ON quota_environments,quota_environment_operations TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_057() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_057();
