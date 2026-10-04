SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_044);

LOCK TABLE console_users, agents IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  missing_aliases text;
BEGIN
  SELECT string_agg(format('human_id=%s tenant_id=%s alias=%s', u.id, u.tenant_id, u.alias), E'\n'
                    ORDER BY u.tenant_id, u.id)
    INTO missing_aliases
    FROM console_users u
    LEFT JOIN agents a ON a.tenant_id = u.tenant_id AND a.alias = u.alias
    WHERE a.alias IS NULL;
  IF missing_aliases IS NOT NULL THEN
    RAISE EXCEPTION 'human identity backfill requires existing agents'
      USING DETAIL = missing_aliases,
            HINT = 'Repair the listed legacy account aliases explicitly before retrying migration 044.';
  END IF;
END;
$$;

CREATE TABLE human_external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  human_id uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('oauth', 'telegram')),
  namespace text COLLATE "C" NOT NULL CHECK (octet_length(namespace) BETWEEN 1 AND 1024),
  subject text COLLATE "C" NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 512),
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, namespace, subject),
  CHECK (enabled = (revoked_at IS NULL)),
  CHECK (provider <> 'telegram' OR subject ~ '^[1-9][0-9]{0,19}$')
);

CREATE TABLE human_tenant_memberships (
  human_id uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_alias text NOT NULL,
  role text NOT NULL CHECK (role IN ('operator', 'reader')),
  permissions text[] NOT NULL DEFAULT ARRAY['read']::text[],
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (human_id, tenant_id),
  FOREIGN KEY (tenant_id, actor_alias) REFERENCES agents(tenant_id, alias) ON DELETE RESTRICT,
  CHECK (array_position(permissions, NULL) IS NULL),
  CHECK (permissions <@ ARRAY['route', 'read', 'control', 'notify']::text[]),
  CHECK (role <> 'reader' OR permissions <@ ARRAY['read']::text[]),
  CHECK (enabled = (revoked_at IS NULL))
);

CREATE UNIQUE INDEX messages_id_tenant_identity_idx ON messages(id, tenant_id);

CREATE TABLE human_message_initiators (
  message_id uuid PRIMARY KEY,
  message_tenant_id text NOT NULL,
  initiating_human_id uuid NOT NULL,
  initiating_tenant_id text NOT NULL,
  root_message_id uuid NOT NULL,
  conversation_id text COLLATE "C" NOT NULL CHECK (octet_length(conversation_id) BETWEEN 1 AND 512),
  root_anchor_id uuid GENERATED ALWAYS AS (root_message_id) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (message_id, message_tenant_id) REFERENCES messages(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (initiating_human_id, initiating_tenant_id)
    REFERENCES human_tenant_memberships(human_id, tenant_id) ON DELETE RESTRICT,
  CHECK (message_id <> root_message_id OR message_tenant_id = initiating_tenant_id),
  UNIQUE (message_id, root_message_id, initiating_human_id, initiating_tenant_id, conversation_id),
  FOREIGN KEY (root_message_id, root_anchor_id, initiating_human_id, initiating_tenant_id, conversation_id)
    REFERENCES human_message_initiators(message_id, root_message_id, initiating_human_id, initiating_tenant_id, conversation_id)
    ON DELETE RESTRICT
);

CREATE INDEX human_message_initiators_owner_idx
  ON human_message_initiators(initiating_tenant_id, initiating_human_id, created_at DESC, message_id);

CREATE FUNCTION enforce_human_identity_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'human identity records must be revoked, not deleted';
  END IF;
  IF TG_TABLE_NAME = 'human_external_identities' THEN
    IF (NEW.id, NEW.human_id, NEW.provider, NEW.namespace, NEW.subject, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.human_id, OLD.provider, OLD.namespace, OLD.subject, OLD.created_at) THEN
      RAISE EXCEPTION 'external identity bindings cannot be reassigned';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'human_tenant_memberships' THEN
    IF (NEW.human_id, NEW.tenant_id, NEW.created_at) IS DISTINCT FROM (OLD.human_id, OLD.tenant_id, OLD.created_at) THEN
      RAISE EXCEPTION 'human membership identities cannot be reassigned';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'human_message_initiators' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'message initiators are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER human_external_identity_immutable BEFORE UPDATE OR DELETE ON human_external_identities
  FOR EACH ROW EXECUTE FUNCTION enforce_human_identity_immutability();
CREATE TRIGGER human_message_initiator_immutable BEFORE UPDATE OR DELETE ON human_message_initiators
  FOR EACH ROW EXECUTE FUNCTION enforce_human_identity_immutability();
CREATE TRIGGER human_membership_preserved BEFORE UPDATE OR DELETE ON human_tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION enforce_human_identity_immutability();

INSERT INTO human_tenant_memberships
  (human_id, tenant_id, actor_alias, role, permissions, enabled, revoked_at)
SELECT id, tenant_id, alias, role,
       CASE WHEN role = 'operator' THEN ARRAY['route', 'read', 'control', 'notify']::text[]
            ELSE ARRAY['read']::text[] END,
       active, CASE WHEN active THEN NULL ELSE now() END
FROM console_users;
