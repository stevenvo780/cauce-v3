ALTER TABLE cauce_oauth_grants ADD CONSTRAINT cauce_oauth_grants_provenance_owner
  UNIQUE (id, human_id, tenant_id);

CREATE TABLE human_oauth_client_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_oauth_grant_id uuid NOT NULL,
  human_id uuid NOT NULL,
  tenant_id text NOT NULL,
  declared_by_human_id uuid NOT NULL CHECK (declared_by_human_id = human_id),
  label text COLLATE "C" NOT NULL CHECK (
    octet_length(label) BETWEEN 1 AND 128 AND
    label !~ '[^A-Za-z0-9 ._-]' AND label ~ '^[A-Za-z0-9]([A-Za-z0-9 ._-]*[A-Za-z0-9])?$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz CHECK (revoked_at >= created_at),
  FOREIGN KEY (local_oauth_grant_id, human_id, tenant_id)
    REFERENCES cauce_oauth_grants(id, human_id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (id, local_oauth_grant_id, human_id, tenant_id)
);
CREATE UNIQUE INDEX human_oauth_client_delegations_active
  ON human_oauth_client_delegations(local_oauth_grant_id) WHERE revoked_at IS NULL;

CREATE TABLE human_message_client_provenance (
  root_message_id uuid PRIMARY KEY,
  root_anchor_id uuid GENERATED ALWAYS AS (root_message_id) STORED,
  initiating_human_id uuid NOT NULL,
  initiating_tenant_id text NOT NULL,
  conversation_id text COLLATE "C" NOT NULL CHECK (octet_length(conversation_id) BETWEEN 1 AND 512),
  local_oauth_grant_id uuid,
  delegation_binding_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (delegation_binding_id IS NULL OR local_oauth_grant_id IS NOT NULL),
  FOREIGN KEY (root_message_id, root_anchor_id, initiating_human_id, initiating_tenant_id, conversation_id)
    REFERENCES human_message_initiators(message_id, root_message_id, initiating_human_id, initiating_tenant_id, conversation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (local_oauth_grant_id, initiating_human_id, initiating_tenant_id)
    REFERENCES cauce_oauth_grants(id, human_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (delegation_binding_id, local_oauth_grant_id, initiating_human_id, initiating_tenant_id)
    REFERENCES human_oauth_client_delegations(id, local_oauth_grant_id, human_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX human_message_client_provenance_grant_activity
  ON human_message_client_provenance(local_oauth_grant_id,created_at DESC) WHERE local_oauth_grant_id IS NOT NULL;

CREATE TABLE human_client_delegation_operations (
  human_id uuid NOT NULL,
  tenant_id text NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('create', 'rename', 'revoke')),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object' AND octet_length(response::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (human_id, tenant_id, request_id),
  FOREIGN KEY (human_id, tenant_id) REFERENCES human_tenant_memberships(human_id, tenant_id) ON DELETE RESTRICT
);

CREATE FUNCTION preserve_human_client_records() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE populated boolean;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO populated;
    IF NOT populated THEN RETURN NULL; END IF;
  ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'human_oauth_client_delegations' THEN
    IF (NEW.id, NEW.local_oauth_grant_id, NEW.human_id, NEW.tenant_id, NEW.declared_by_human_id, NEW.label, NEW.created_at)
       IS NOT DISTINCT FROM
       (OLD.id, OLD.local_oauth_grant_id, OLD.human_id, OLD.tenant_id, OLD.declared_by_human_id, OLD.label, OLD.created_at)
       AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'human client records are permanent; only declaration revocation is allowed';
END;
$$;
CREATE TRIGGER human_client_root_immutable BEFORE UPDATE OR DELETE ON human_message_client_provenance
  FOR EACH ROW EXECUTE FUNCTION preserve_human_client_records();
CREATE TRIGGER human_client_root_preserved BEFORE TRUNCATE ON human_message_client_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION preserve_human_client_records();
CREATE TRIGGER human_client_declaration_immutable BEFORE UPDATE OR DELETE ON human_oauth_client_delegations
  FOR EACH ROW EXECUTE FUNCTION preserve_human_client_records();
CREATE TRIGGER human_client_declaration_preserved BEFORE TRUNCATE ON human_oauth_client_delegations
  FOR EACH STATEMENT EXECUTE FUNCTION preserve_human_client_records();
CREATE TRIGGER human_client_operation_immutable BEFORE UPDATE OR DELETE ON human_client_delegation_operations
  FOR EACH ROW EXECUTE FUNCTION preserve_human_client_records();
CREATE TRIGGER human_client_operation_preserved BEFORE TRUNCATE ON human_client_delegation_operations
  FOR EACH STATEMENT EXECUTE FUNCTION preserve_human_client_records();
