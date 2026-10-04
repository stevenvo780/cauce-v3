SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_045);
LOCK TABLE console_users, human_external_identities, human_tenant_memberships IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE human_external_identities ADD CONSTRAINT human_external_identity_oauth_owner UNIQUE (id,human_id);

CREATE DOMAIN cauce_oauth_scopes AS text[] CHECK (
  VALUE IS NOT NULL AND array_ndims(VALUE)=1 AND array_lower(VALUE,1)=1 AND cardinality(VALUE) BETWEEN 1 AND 2
  AND array_position(VALUE,NULL) IS NULL
  AND VALUE <@ ARRAY['cauce.read','cauce.publish']::text[]
  AND (cardinality(VALUE)=1 OR VALUE[1]<>VALUE[2])
);
CREATE TABLE cauce_oauth_requests (
  id_hash text PRIMARY KEY CHECK (id_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  client_id text COLLATE "C" NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 200),
  redirect_uri text COLLATE "C" NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2048),
  resource text COLLATE "C" NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  scopes cauce_oauth_scopes NOT NULL,
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state text CHECK (char_length(state)<=512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
  consumed_at timestamptz CHECK (consumed_at>=created_at AND consumed_at<expires_at)
);
CREATE TABLE cauce_oauth_grants (
  id uuid PRIMARY KEY,
  human_id uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  issuer text COLLATE "C" NOT NULL CHECK (octet_length(issuer) BETWEEN 1 AND 2048),
  resource text COLLATE "C" NOT NULL CHECK (resource=issuer||'/mcp'),
  client_id text COLLATE "C" NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  redirect_uri text COLLATE "C" NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2048),
  scopes cauce_oauth_scopes NOT NULL,
  binding_id uuid NOT NULL,
  binding_revision bigint NOT NULL CHECK (binding_revision>0),
  membership_revision bigint NOT NULL CHECK (membership_revision>0),
  tenant_id text NOT NULL,
  actor_alias text NOT NULL,
  credential_stamp text NOT NULL CHECK (credential_stamp ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at AND expires_at<=created_at+interval '8 hours'),
  revoked_at timestamptz CHECK (revoked_at>=created_at),
  FOREIGN KEY (binding_id,human_id) REFERENCES human_external_identities(id,human_id) ON DELETE RESTRICT,
  FOREIGN KEY (human_id,tenant_id) REFERENCES human_tenant_memberships(human_id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,actor_alias) REFERENCES agents(tenant_id,alias) ON DELETE RESTRICT
);
CREATE TABLE cauce_oauth_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  grant_id uuid NOT NULL REFERENCES cauce_oauth_grants(id) ON DELETE RESTRICT,
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at AND expires_at<=created_at+interval '60 seconds'),
  consumed_at timestamptz CHECK (consumed_at>=created_at AND consumed_at<expires_at)
);
CREATE TABLE cauce_oauth_tokens (
  id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES cauce_oauth_grants(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
  revoked_at timestamptz CHECK (revoked_at>=created_at)
);

CREATE FUNCTION cauce_oauth_preserve_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable_field text;
BEGIN
  IF TG_OP='DELETE' THEN
    IF TG_TABLE_NAME='cauce_oauth_grants' OR OLD.expires_at>clock_timestamp() THEN
      RAISE EXCEPTION 'OAuth authority must be revoked before an approved retention procedure';
    END IF;
    RETURN OLD;
  END IF;
  mutable_field := CASE WHEN TG_TABLE_NAME IN ('cauce_oauth_grants','cauce_oauth_tokens')
                       THEN 'revoked_at' ELSE 'consumed_at' END;
  IF (to_jsonb(NEW)-mutable_field) IS DISTINCT FROM (to_jsonb(OLD)-mutable_field)
     OR ((to_jsonb(OLD)->mutable_field) <> 'null'::jsonb
         AND (to_jsonb(NEW)->mutable_field) IS DISTINCT FROM (to_jsonb(OLD)->mutable_field)) THEN
    RAISE EXCEPTION 'OAuth identity fields and completed transitions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cauce_oauth_request_preserved BEFORE UPDATE OR DELETE ON cauce_oauth_requests
  FOR EACH ROW EXECUTE FUNCTION cauce_oauth_preserve_authority();
CREATE TRIGGER cauce_oauth_grant_preserved BEFORE UPDATE OR DELETE ON cauce_oauth_grants
  FOR EACH ROW EXECUTE FUNCTION cauce_oauth_preserve_authority();
CREATE TRIGGER cauce_oauth_code_preserved BEFORE UPDATE OR DELETE ON cauce_oauth_codes
  FOR EACH ROW EXECUTE FUNCTION cauce_oauth_preserve_authority();
CREATE TRIGGER cauce_oauth_token_preserved BEFORE UPDATE OR DELETE ON cauce_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION cauce_oauth_preserve_authority();
CREATE INDEX cauce_oauth_requests_expiry ON cauce_oauth_requests(expires_at);
CREATE INDEX cauce_oauth_codes_expiry ON cauce_oauth_codes(expires_at);
CREATE INDEX cauce_oauth_tokens_grant ON cauce_oauth_tokens(grant_id,expires_at);
CREATE INDEX cauce_oauth_grants_owner ON cauce_oauth_grants(human_id,issuer,resource,created_at DESC,id DESC);

CREATE FUNCTION cauce_oauth_advance_identity_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean;
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'Human identity revision cannot decrease';
  END IF;
  IF TG_TABLE_NAME='human_external_identities' THEN
    changed := (NEW.enabled, NEW.revoked_at) IS DISTINCT FROM (OLD.enabled, OLD.revoked_at);
  ELSE
    changed := (NEW.enabled, NEW.revoked_at, NEW.actor_alias, NEW.role, NEW.permissions)
      IS DISTINCT FROM (OLD.enabled, OLD.revoked_at, OLD.actor_alias, OLD.role, OLD.permissions);
  END IF;
  IF changed THEN NEW.revision := GREATEST(NEW.revision, OLD.revision+1); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cauce_oauth_binding_revision BEFORE UPDATE ON human_external_identities
  FOR EACH ROW EXECUTE FUNCTION cauce_oauth_advance_identity_revision();
CREATE TRIGGER cauce_oauth_membership_revision BEFORE UPDATE ON human_tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION cauce_oauth_advance_identity_revision();

CREATE FUNCTION cauce_oauth_reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cauce_oauth_requests)
     OR EXISTS (SELECT 1 FROM cauce_oauth_grants)
     OR EXISTS (SELECT 1 FROM cauce_oauth_codes)
     OR EXISTS (SELECT 1 FROM cauce_oauth_tokens) THEN
    RAISE EXCEPTION 'OAuth retention requires an approved procedure';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cauce_oauth_requests_no_truncate BEFORE TRUNCATE ON cauce_oauth_requests
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_oauth_reject_truncate();
CREATE TRIGGER cauce_oauth_grants_no_truncate BEFORE TRUNCATE ON cauce_oauth_grants
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_oauth_reject_truncate();
CREATE TRIGGER cauce_oauth_codes_no_truncate BEFORE TRUNCATE ON cauce_oauth_codes
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_oauth_reject_truncate();
CREATE TRIGGER cauce_oauth_tokens_no_truncate BEFORE TRUNCATE ON cauce_oauth_tokens
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_oauth_reject_truncate();

