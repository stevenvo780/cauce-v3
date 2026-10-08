SELECT pg_advisory_xact_lock(783_003_047);

ALTER TABLE tenants ADD COLUMN retired_at timestamptz, ADD COLUMN retired_enabled boolean;
ALTER TABLE rooms ADD COLUMN retired_at timestamptz, ADD COLUMN retired_enabled boolean;
ALTER TABLE memberships ADD COLUMN retired_at timestamptz, ADD COLUMN retired_enabled boolean;
ALTER TABLE tenants ADD CONSTRAINT tenants_retirement_admission CHECK (
  (retired_at IS NULL AND retired_enabled IS NULL) OR (retired_at IS NOT NULL AND retired_enabled IS NOT NULL AND NOT enabled));
ALTER TABLE rooms ADD CONSTRAINT rooms_retirement_admission CHECK (
  (retired_at IS NULL AND retired_enabled IS NULL) OR (retired_at IS NOT NULL AND retired_enabled IS NOT NULL AND NOT enabled));
ALTER TABLE memberships ADD CONSTRAINT memberships_retirement_admission CHECK (
  (retired_at IS NULL AND retired_enabled IS NULL) OR (retired_at IS NOT NULL AND retired_enabled IS NOT NULL AND NOT enabled));

ALTER TABLE agents
  ADD COLUMN runtime_key text UNIQUE CHECK (runtime_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD COLUMN primary_room_id text,
  ADD COLUMN host_id text CHECK (host_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD COLUMN runtime_mode text CHECK (runtime_mode IN ('container','native')),
  ADD COLUMN systemd_user text,
  ADD COLUMN primary_account_id text REFERENCES provider_accounts(id),
  ADD COLUMN model_id text,
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_state IN ('draft','provisioning','auth_pending','verifying','ready','failed','retiring','retired')),
  ADD COLUMN retired_at timestamptz,
  ADD CONSTRAINT agents_primary_room_membership FOREIGN KEY (tenant_id,primary_room_id,alias)
    REFERENCES memberships(tenant_id,room_id,alias),
  ADD CONSTRAINT agents_retirement_admission CHECK (retired_at IS NULL OR NOT enabled);

UPDATE agents agent SET runtime_key=agent.alias
  WHERE agent.alias ~ '^[a-z][a-z0-9-]{0,63}$' AND NOT EXISTS (
    SELECT 1 FROM agents other WHERE other.alias=agent.alias AND other.tenant_id<>agent.tenant_id);
DO $$
DECLARE agent_identity record; candidate text; collision_attempt bigint;
BEGIN
  FOR agent_identity IN SELECT tenant_id,alias FROM agents WHERE runtime_key IS NULL ORDER BY tenant_id,alias LOOP
    candidate := left(replace(agent_identity.alias,'_','-'),42) || '-' ||
      left(encode(digest(agent_identity.tenant_id || '/' || agent_identity.alias,'sha256'),'hex'),16);
    collision_attempt := 0;
    WHILE EXISTS (SELECT 1 FROM agents WHERE runtime_key=candidate) LOOP
      collision_attempt := collision_attempt+1;
      candidate := 'agent-' || left(encode(digest(agent_identity.tenant_id || '/' ||
        agent_identity.alias || '#' || collision_attempt::text,'sha256'),'hex'),58);
    END LOOP;
    UPDATE agents SET runtime_key=candidate WHERE tenant_id=agent_identity.tenant_id AND alias=agent_identity.alias;
  END LOOP;
END;
$$;
UPDATE agents SET lifecycle_state=CASE WHEN enabled THEN 'verifying' ELSE 'draft' END;
UPDATE agents agent SET primary_room_id=(
  SELECT min(room_id) FROM memberships membership
  WHERE membership.tenant_id=agent.tenant_id AND membership.alias=agent.alias AND membership.enabled
  HAVING count(*)=1
);

CREATE TABLE fleet_runtime_identities (
  runtime_key text PRIMARY KEY CHECK (runtime_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  tenant_id text NOT NULL,
  alias text NOT NULL,
  baseline boolean NOT NULL DEFAULT false,
  baseline_state jsonb CHECK (baseline_state IS NULL OR jsonb_typeof(baseline_state)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,alias),
  CHECK (NOT baseline OR baseline_state IS NOT NULL)
);
INSERT INTO fleet_runtime_identities(runtime_key,tenant_id,alias,baseline,baseline_state)
  SELECT runtime_key,tenant_id,alias,true,jsonb_build_object(
    'primary_room_id',primary_room_id,'lifecycle_state',lifecycle_state,
    'runtime_mode',runtime_mode,'systemd_user',systemd_user,'host_id',host_id,
    'primary_account_id',primary_account_id,'model_id',model_id)
  FROM agents WHERE runtime_key IS NOT NULL;

CREATE FUNCTION preserve_fleet_runtime_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'fleet runtime identities are permanent';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fleet_runtime_identity_permanent BEFORE UPDATE OR DELETE ON fleet_runtime_identities
  FOR EACH ROW EXECUTE FUNCTION preserve_fleet_runtime_identity();

CREATE FUNCTION reserve_agent_runtime_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.runtime_key IS NOT NULL THEN
    IF NEW.runtime_key IS DISTINCT FROM OLD.runtime_key THEN
      RAISE EXCEPTION 'agent runtime key is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.runtime_key IS NOT NULL THEN
    INSERT INTO fleet_runtime_identities(runtime_key,tenant_id,alias)
      VALUES(NEW.runtime_key,NEW.tenant_id,NEW.alias);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_runtime_key_reservation BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION reserve_agent_runtime_key();

CREATE TABLE fleet_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_tenant text NOT NULL REFERENCES tenants(id),
  actor_alias text NOT NULL,
  target jsonb NOT NULL CHECK (jsonb_typeof(target)='object'),
  target_key text NOT NULL,
  cohort_key text NOT NULL,
  executor_host text NOT NULL CHECK (executor_host ~ '^[a-z][a-z0-9_-]{0,63}$'),
  kind text NOT NULL CHECK (kind IN ('create','update','start','stop','retire','restore','purge')),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  expected_revision bigint NOT NULL CHECK (expected_revision>=0),
  desired_revision bigint CHECK (desired_revision>=0),
  applied_revision bigint CHECK (applied_revision>=0),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','awaiting_auth','cancelling','cancelled','failed','succeeded')),
  version bigint NOT NULL DEFAULT 0 CHECK (version>=0),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps)='array'),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error)='object'),
  cancel_requested boolean NOT NULL DEFAULT false,
  worker_id text,
  claim_token uuid,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch>=0),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_tenant,actor_alias,idempotency_key),
  CHECK (num_nonnulls(worker_id,claim_token,lease_expires_at) IN (0,3)),
  CHECK (applied_revision IS NULL OR desired_revision IS NOT NULL)
);
CREATE UNIQUE INDEX fleet_operations_active_target ON fleet_operations(target_key)
  WHERE status NOT IN ('cancelled','succeeded');
CREATE UNIQUE INDEX fleet_operations_active_cohort ON fleet_operations(cohort_key)
  WHERE worker_id IS NOT NULL;
CREATE INDEX fleet_operations_queue ON fleet_operations(created_at,id) WHERE status IN ('queued','running','cancelling');

CREATE TABLE fleet_operation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES fleet_operations(id),
  version bigint NOT NULL CHECK (version>=0),
  event text NOT NULL CHECK (event IN ('queued','claimed','renewed','step_started','step_completed',
    'awaiting_auth','failed','resumed','cancel_requested','cancelled','succeeded')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_operation_events_operation ON fleet_operation_events(operation_id,id);

CREATE FUNCTION preserve_fleet_operation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_TABLE_NAME='fleet_operation_events' THEN
    RAISE EXCEPTION 'fleet operation history is permanent';
  END IF;
  IF ROW(NEW.actor_tenant,NEW.actor_alias,NEW.target,NEW.target_key,NEW.cohort_key,NEW.executor_host,NEW.kind,
         NEW.request,NEW.request_hash,NEW.idempotency_key,NEW.expected_revision,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.actor_tenant,OLD.actor_alias,OLD.target,OLD.target_key,OLD.cohort_key,OLD.executor_host,OLD.kind,
         OLD.request,OLD.request_hash,OLD.idempotency_key,OLD.expected_revision,OLD.created_at) THEN
    RAISE EXCEPTION 'fleet operation attribution and request are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fleet_operations_history BEFORE UPDATE OR DELETE ON fleet_operations
  FOR EACH ROW EXECUTE FUNCTION preserve_fleet_operation_history();
CREATE TRIGGER fleet_events_history BEFORE UPDATE OR DELETE ON fleet_operation_events
  FOR EACH ROW EXECUTE FUNCTION preserve_fleet_operation_history();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cauce_gateway') THEN
    GRANT SELECT,INSERT,UPDATE ON fleet_operations TO cauce_gateway;
    GRANT SELECT,INSERT ON fleet_operation_events,fleet_runtime_identities TO cauce_gateway;
    GRANT USAGE,SELECT ON SEQUENCE fleet_operation_events_id_seq TO cauce_gateway;
  END IF;
END;
$$;
