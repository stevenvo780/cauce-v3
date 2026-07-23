-- Additive hardening: fencing tokens, independent deadlines, durable worker leases,
-- data-driven authorization and transactional lane fairness.

-- Tenants and the hub are data, not protocol/DDL enums.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_known;
DO $$
DECLARE had_hub_column boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='tenants' AND column_name='is_hub'
  ) INTO had_hub_column;
  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_hub boolean NOT NULL DEFAULT false;
  IF NOT had_hub_column THEN UPDATE tenants SET is_hub=true WHERE id='Steven'; END IF;
END $$;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_single_hub_idx ON tenants (is_hub) WHERE is_hub;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'acl_edges'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%Steven%'
  LOOP
    EXECUTE format('ALTER TABLE acl_edges DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

-- Upgrade existing explicit edges exactly once. Re-running this file must never turn a newly
-- default-deny edge into an allow edge.
DO $$
DECLARE had_permission_columns boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='acl_edges' AND column_name='allow_route'
  ) INTO had_permission_columns;
  ALTER TABLE acl_edges ADD COLUMN IF NOT EXISTS allow_route boolean NOT NULL DEFAULT false;
  ALTER TABLE acl_edges ADD COLUMN IF NOT EXISTS allow_read boolean NOT NULL DEFAULT false;
  ALTER TABLE acl_edges ADD COLUMN IF NOT EXISTS allow_control boolean NOT NULL DEFAULT false;
  IF NOT had_permission_columns THEN
    UPDATE acl_edges SET allow_route=true,allow_read=true,allow_control=true WHERE enabled;
  END IF;
END $$;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS role_policies (
  role text PRIMARY KEY,
  allow_route boolean NOT NULL DEFAULT false,
  allow_read boolean NOT NULL DEFAULT false,
  allow_control boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO role_policies(role,allow_route,allow_read,allow_control) VALUES
  ('agent',true,true,false),
  ('operator',true,true,true),
  ('adapter',true,true,false)
ON CONFLICT (role) DO NOTHING;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
DO $$
DECLARE had_role_fk boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'memberships'::regclass
      AND conname = 'memberships_role_policy_fk'
  ) INTO had_role_fk;
  IF NOT had_role_fk THEN
    ALTER TABLE memberships ADD CONSTRAINT memberships_role_policy_fk
      FOREIGN KEY (role) REFERENCES role_policies(role);
    -- Seed the original hub operator exactly once; later config changes are preserved.
    UPDATE memberships SET role='operator' WHERE tenant_id='Steven' AND alias='kant';
  END IF;
END $$;

-- Trusted authentication context is immutable message provenance.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS auth_session_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS auth_channel text;

-- A delivery claim is fenced by an unguessable token and its own ACK deadline.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS ack_deadline_at timestamptz;
UPDATE deliveries
SET claim_token = COALESCE(claim_token, gen_random_uuid()),
    ack_deadline_at = COALESCE(ack_deadline_at, claim_expires_at, now())
WHERE status IN ('leased','accepted','started');
DROP INDEX IF EXISTS deliveries_inflight_idx;
CREATE INDEX deliveries_inflight_idx ON deliveries (ack_deadline_at, claimed_at)
  WHERE status IN ('leased','accepted','started');

ALTER TABLE delivery_acks ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE delivery_acks ADD COLUMN IF NOT EXISTS attempt integer;
ALTER TABLE delivery_acks ADD COLUMN IF NOT EXISTS event_id uuid;
UPDATE delivery_acks a
SET claim_token = COALESCE(a.claim_token, gen_random_uuid()),
    attempt = COALESCE(a.attempt, GREATEST(1, d.attempt))
FROM deliveries d
WHERE d.id = a.delivery_id
  AND (a.claim_token IS NULL OR a.attempt IS NULL);
UPDATE delivery_acks SET event_id=gen_random_uuid() WHERE event_id IS NULL;
ALTER TABLE delivery_acks ALTER COLUMN claim_token SET NOT NULL;
ALTER TABLE delivery_acks ALTER COLUMN attempt SET NOT NULL;
ALTER TABLE delivery_acks ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE delivery_acks DROP CONSTRAINT IF EXISTS delivery_acks_attempt_check;
ALTER TABLE delivery_acks ADD CONSTRAINT delivery_acks_attempt_check CHECK (attempt > 0);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_acks_event_id_idx ON delivery_acks(event_id);

CREATE TABLE IF NOT EXISTS delivery_lane_fairness (
  tenant_id text NOT NULL REFERENCES tenants(id),
  alias text NOT NULL,
  interactive_streak integer NOT NULL DEFAULT 0 CHECK (interactive_streak >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alias)
);

-- Job completions/failures are valid only for the exact live claim.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claim_token uuid;
CREATE INDEX IF NOT EXISTS jobs_running_expiry_idx ON jobs (lease_until)
  WHERE status = 'running';
CREATE TABLE IF NOT EXISTS job_lane_fairness (
  scope text PRIMARY KEY,
  interactive_streak integer NOT NULL DEFAULT 0 CHECK (interactive_streak >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Outbox processing is a leased queue with retry exhaustion and a durable DLQ.
ALTER TABLE adapter_outbox ADD COLUMN IF NOT EXISTS claimed_by text;
ALTER TABLE adapter_outbox ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE adapter_outbox ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
ALTER TABLE adapter_outbox ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
ALTER TABLE adapter_outbox ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE adapter_outbox ADD COLUMN IF NOT EXISTS dead_at timestamptz;
ALTER TABLE adapter_outbox DROP CONSTRAINT IF EXISTS adapter_outbox_status_check;
ALTER TABLE adapter_outbox ADD CONSTRAINT adapter_outbox_status_check
  CHECK (status IN ('pending','processing','sent','failed','dead'));
ALTER TABLE adapter_outbox DROP CONSTRAINT IF EXISTS adapter_outbox_max_attempts_check;
ALTER TABLE adapter_outbox ADD CONSTRAINT adapter_outbox_max_attempts_check CHECK (max_attempts > 0);
DROP INDEX IF EXISTS adapter_outbox_claim_idx;
CREATE INDEX adapter_outbox_claim_idx ON adapter_outbox (kind, available_at, created_at)
  WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS adapter_outbox_processing_expiry_idx ON adapter_outbox (claim_expires_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS outbox_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL UNIQUE REFERENCES adapter_outbox(id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  adapter text NOT NULL,
  kind text NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_dead_letters_open_idx
  ON outbox_dead_letters (tenant_id, created_at) WHERE resolved_at IS NULL;

-- Server-managed adapter definitions and atomically auditable configuration revisions.
CREATE TABLE IF NOT EXISTS harness_definitions (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  command text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities)='array'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO harness_definitions(id,display_name,capabilities) VALUES
  ('hermes','Hermes','["messages.receive","ack.timeline","origin.relay"]'::jsonb),
  ('opencode','OpenCode','["messages.receive","jobs.interactive","jobs.batch"]'::jsonb),
  ('claude','Claude Code','["messages.receive","jobs.interactive"]'::jsonb),
  ('codex','Codex','["messages.receive","jobs.interactive","jobs.batch"]'::jsonb),
  ('fake','Fake QA','["messages.receive","ack.timeline"]'::jsonb)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS config_revisions (
  id bigserial PRIMARY KEY,
  actor_tenant text NOT NULL REFERENCES tenants(id),
  actor_alias text NOT NULL,
  operation jsonb NOT NULL CHECK (jsonb_typeof(operation)='object'),
  inverse_operation jsonb NOT NULL CHECK (jsonb_typeof(inverse_operation)='object'),
  summary text NOT NULL,
  rolled_back_revision_id bigint REFERENCES config_revisions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS config_revisions_created_idx ON config_revisions(created_at DESC);
