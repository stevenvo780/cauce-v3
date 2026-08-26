-- Causal, auditable reconciliation for delivery/outbox dead letters.
--
-- A DLQ row is an incident projection, not evidence that a remote side effect happened.  This
-- migration therefore separates three facts which older code conflated:
--   * disposition: what an operator can safely do next;
--   * resolution_rule/evidence_sha256: why the incident no longer needs attention;
--   * adapter_outbox.status: whether a remote send is durably proven.
-- Only the strict Telegram chunk proof below may recover an outbox from dead to sent.

SELECT pg_advisory_xact_lock(783_003_003);
-- Hold writer-incompatible locks from the start of the migration through COMMIT.  Otherwise an
-- effect writer can commit inconsistent cross-table evidence after the preflight snapshot but
-- before the fencing trigger is installed.
LOCK TABLE adapter_outbox,dead_letters,outbox_dead_letters,telegram_egress_effects
IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'unclassified',
  ADD COLUMN IF NOT EXISTS disposition_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_rule text,
  ADD COLUMN IF NOT EXISTS evidence_sha256 text;

ALTER TABLE outbox_dead_letters
  ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'unclassified',
  ADD COLUMN IF NOT EXISTS disposition_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_rule text,
  ADD COLUMN IF NOT EXISTS evidence_sha256 text,
  ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reopened_at timestamptz;

ALTER TABLE dead_letters
  DROP CONSTRAINT IF EXISTS dead_letters_disposition_check,
  DROP CONSTRAINT IF EXISTS dead_letters_evidence_sha256_check;
ALTER TABLE dead_letters
  ADD CONSTRAINT dead_letters_disposition_check CHECK (
    disposition IN ('ambiguous','safe_retry','missing_final','auth','expected_offline','unclassified')
  ),
  ADD CONSTRAINT dead_letters_evidence_sha256_check CHECK (
    evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE outbox_dead_letters
  DROP CONSTRAINT IF EXISTS outbox_dead_letters_disposition_check,
  DROP CONSTRAINT IF EXISTS outbox_dead_letters_evidence_sha256_check,
  DROP CONSTRAINT IF EXISTS outbox_dead_letters_reopen_count_check;
ALTER TABLE outbox_dead_letters
  ADD CONSTRAINT outbox_dead_letters_disposition_check CHECK (
    disposition IN ('ambiguous','safe_retry','missing_final','auth','expected_offline','unclassified')
  ),
  ADD CONSTRAINT outbox_dead_letters_evidence_sha256_check CHECK (
    evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT outbox_dead_letters_reopen_count_check CHECK (reopen_count >= 0);

CREATE INDEX IF NOT EXISTS dead_letters_open_disposition_idx
  ON dead_letters(disposition,tenant_id,created_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_dead_letters_open_disposition_idx
  ON outbox_dead_letters(disposition,adapter,kind,created_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS audit_events_delivery_causal_030_idx
  ON audit_events(delivery_id,id)
  WHERE delivery_id IS NOT NULL AND decision='allow'
    AND action IN (
      'delivery.cancel','agent_output.materialize','agent_output.response','agent_output.fanin'
    );

-- One row per logical transition.  It is the exactly-once anchor for audit_events; the audit row
-- deliberately contains no payload, origin, provider id, message id, delivery id or outbox id.
CREATE TABLE IF NOT EXISTS dlq_reconciliation_transitions (
  id bigserial PRIMARY KEY,
  target text NOT NULL CHECK (target IN ('delivery','outbox')),
  dead_letter_id uuid NOT NULL,
  rule text NOT NULL CHECK (rule ~ '^[a-z0-9_]+_v[0-9]+$'),
  actor_tenant text NOT NULL REFERENCES tenants(id),
  actor_alias text NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  from_disposition text NOT NULL,
  to_disposition text NOT NULL,
  resolved boolean NOT NULL,
  audit_event_id bigint NOT NULL UNIQUE REFERENCES audit_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(target,dead_letter_id,rule,evidence_sha256)
);

CREATE TABLE IF NOT EXISTS dlq_reconciliation_runs (
  plan_sha256 text PRIMARY KEY CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  actor_sha256 text NOT NULL CHECK (actor_sha256 ~ '^[a-f0-9]{64}$'),
  transition_count integer NOT NULL CHECK (transition_count >= 0),
  resolved_count integer NOT NULL CHECK (resolved_count >= 0),
  recovered_sent_count integer NOT NULL CHECK (recovered_sent_count >= 0),
  disposition_count integer NOT NULL CHECK (disposition_count >= 0),
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Manual replay is a separate, explicit operator transition.  Reasons stay durable here; the
-- public audit contains only their digest.  No provider id is copied into this ledger.
CREATE TABLE IF NOT EXISTS telegram_manual_replays (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  effect_id text NOT NULL REFERENCES telegram_egress_effects(effect_id),
  outbox_id uuid NOT NULL REFERENCES adapter_outbox(id),
  dead_letter_id uuid NOT NULL REFERENCES outbox_dead_letters(id),
  expected_incident_evidence_sha256 text NOT NULL,
  expected_replay_count integer NOT NULL,
  replay_sequence integer NOT NULL CHECK (replay_sequence > 0),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  actor_tenant text NOT NULL REFERENCES tenants(id),
  actor_alias text NOT NULL,
  reason text NOT NULL CHECK (
    length(btrim(reason)) BETWEEN 1 AND 1000 AND reason !~ '[[:cntrl:]]'
  ),
  duplicate_risk boolean NOT NULL DEFAULT true,
  duplicate_risk_acknowledged boolean NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  audit_event_id bigint NOT NULL UNIQUE REFERENCES audit_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(effect_id,replay_sequence)
);
ALTER TABLE telegram_manual_replays
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS dead_letter_id uuid REFERENCES outbox_dead_letters(id),
  ADD COLUMN IF NOT EXISTS expected_incident_evidence_sha256 text,
  ADD COLUMN IF NOT EXISTS expected_replay_count integer,
  ADD COLUMN IF NOT EXISTS duplicate_risk boolean NOT NULL DEFAULT true,
  DROP CONSTRAINT IF EXISTS telegram_manual_replays_duplicate_risk_acknowledged_check,
  DROP CONSTRAINT IF EXISTS telegram_manual_replays_duplicate_risk_ack_check;
UPDATE telegram_manual_replays SET request_id=gen_random_uuid() WHERE request_id IS NULL;
UPDATE telegram_manual_replays replay SET
  dead_letter_id=letter.id,
  expected_incident_evidence_sha256=COALESCE(letter.evidence_sha256,replay.evidence_sha256),
  expected_replay_count=GREATEST(replay.replay_sequence-1,0)
FROM outbox_dead_letters letter
WHERE replay.outbox_id=letter.outbox_id
  AND (
    replay.dead_letter_id IS NULL
    OR replay.expected_incident_evidence_sha256 IS NULL
    OR replay.expected_replay_count IS NULL
  );
ALTER TABLE telegram_manual_replays
  ALTER COLUMN request_id SET NOT NULL,
  ALTER COLUMN dead_letter_id SET NOT NULL,
  ALTER COLUMN expected_incident_evidence_sha256 SET NOT NULL,
  ALTER COLUMN expected_replay_count SET NOT NULL,
  DROP CONSTRAINT IF EXISTS telegram_manual_replays_expected_incident_evidence_check,
  DROP CONSTRAINT IF EXISTS telegram_manual_replays_expected_replay_count_check,
  ADD CONSTRAINT telegram_manual_replays_expected_incident_evidence_check
    CHECK (expected_incident_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT telegram_manual_replays_expected_replay_count_check
    CHECK (expected_replay_count >= 0),
  ADD CONSTRAINT telegram_manual_replays_duplicate_risk_ack_check
  CHECK (NOT duplicate_risk OR duplicate_risk_acknowledged);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_manual_replays_request_id_idx
  ON telegram_manual_replays(request_id);

-- Closing an ambiguous incident without replay is an operator decision, not evidence of delivery.
-- It has its own immutable ledger and never updates adapter_outbox or telegram_egress_effects.
CREATE TABLE IF NOT EXISTS dlq_operator_resolutions (
  id bigserial PRIMARY KEY,
  target text NOT NULL CHECK (target IN ('delivery','outbox')),
  dead_letter_id uuid NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  actor_tenant text NOT NULL REFERENCES tenants(id),
  actor_alias text NOT NULL,
  reason text NOT NULL CHECK (
    length(btrim(reason)) BETWEEN 1 AND 1000 AND reason !~ '[[:cntrl:]]'
  ),
  possible_duplicate_acknowledged boolean NOT NULL,
  possible_no_delivery_acknowledged boolean NOT NULL,
  audit_event_id bigint NOT NULL UNIQUE REFERENCES audit_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(target,dead_letter_id,evidence_sha256)
);

CREATE OR REPLACE VIEW cauce_dlq_inventory_030 AS
SELECT source,kind,disposition,open,actionable,count(*)::bigint AS count
FROM (
  SELECT 'delivery'::text AS source,
         CASE WHEN delivery_id IS NOT NULL THEN 'delivery' ELSE 'job' END::text AS kind,
         disposition,resolved_at IS NULL AS open,
         resolved_at IS NULL AND disposition IN ('ambiguous','safe_retry','missing_final','auth') AS actionable
  FROM dead_letters
  UNION ALL
  SELECT 'outbox'::text,kind,disposition,resolved_at IS NULL,
         resolved_at IS NULL AND disposition IN ('ambiguous','safe_retry','missing_final','auth')
  FROM outbox_dead_letters
) inventory
GROUP BY source,kind,disposition,open,actionable;

CREATE OR REPLACE FUNCTION cauce_dlq_assert_control_030(
  p_actor_tenant text,
  p_actor_alias text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actor_tenant IS NULL OR p_actor_alias IS NULL OR btrim(p_actor_alias) = '' THEN
    RAISE EXCEPTION 'DLQ reconciliation requires an explicit actor';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM memberships membership
    JOIN role_policies role ON role.role=membership.role
    JOIN tenants tenant ON tenant.id=membership.tenant_id
    JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
    WHERE membership.tenant_id=p_actor_tenant AND membership.alias=p_actor_alias
      AND membership.enabled AND tenant.enabled AND room.enabled AND role.allow_control
  ) THEN
    RAISE EXCEPTION 'DLQ reconciliation actor lacks control permission';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION cauce_dlq_can_control_tenant_030(
  p_actor_tenant text,
  p_target_tenant text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
SELECT EXISTS (
  SELECT 1
    FROM tenants target_tenant
   WHERE target_tenant.id=p_target_tenant AND target_tenant.enabled
     AND (
       p_actor_tenant=p_target_tenant
       OR EXISTS (
         SELECT 1
           FROM acl_edges edge
           JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
          WHERE edge.from_tenant=p_actor_tenant AND edge.to_tenant=p_target_tenant
            AND edge.enabled AND edge.allow_control AND source_tenant.enabled
            AND (source_tenant.is_hub OR target_tenant.is_hub)
       )
     )
)
$$;

-- Mutation/read scope primitive.  Every operational surface takes the same deterministic row
-- locks before it trusts actor role or cross-tenant topology, then revalidates under those locks.
-- A concurrent membership/role/room/tenant/ACL revocation either commits first and is observed,
-- or waits until the already-authorized statement commits.
CREATE OR REPLACE FUNCTION cauce_dlq_lock_control_tenant_030(
  p_actor_tenant text,
  p_actor_alias text,
  p_target_tenant text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
  FROM memberships membership
  JOIN role_policies role ON role.role=membership.role
  JOIN tenants actor_tenant ON actor_tenant.id=membership.tenant_id
  JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
  WHERE membership.tenant_id=p_actor_tenant AND membership.alias=p_actor_alias
  ORDER BY membership.room_id
  FOR SHARE OF membership,role,actor_tenant,room;
  PERFORM 1 FROM acl_edges edge
  WHERE edge.from_tenant=p_actor_tenant AND edge.to_tenant=p_target_tenant
  FOR SHARE OF edge;
  PERFORM 1 FROM tenants scoped_tenant
  WHERE scoped_tenant.id IN (p_actor_tenant,p_target_tenant)
  ORDER BY scoped_tenant.id FOR SHARE OF scoped_tenant;
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  RETURN cauce_dlq_can_control_tenant_030(p_actor_tenant,p_target_tenant);
END
$$;

-- Every effect writer, including ad-hoc SQL and future repository implementations, shares this
-- outbox-stable fence with both reconcilers.  A new chunk is only legal while the outbox owns a
-- live processing attempt; once exact-sent reconciliation commits, a late INSERT cannot invalidate
-- the proof it just consumed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM telegram_egress_effects effect
    LEFT JOIN adapter_outbox outbox ON outbox.id=effect.outbox_id
    WHERE outbox.id IS NULL OR effect.tenant_id<>outbox.tenant_id
       OR outbox.adapter<>'telegram' OR outbox.kind<>'origin_relay'
       OR (effect.state='sent' AND (
         effect.provider_message_id IS NULL OR btrim(effect.provider_message_id)=''
         OR effect.sent_at IS NULL
       ))
       OR (effect.state='prepared' AND (
         effect.sending_at IS NOT NULL OR effect.provider_message_id IS NOT NULL
         OR effect.sent_at IS NOT NULL
       ))
       OR effect.replay_count<0
       OR (effect.replay_count=0 AND effect.replayed_at IS NOT NULL)
       OR (effect.replay_count>0 AND effect.replayed_at IS NULL)
  ) OR EXISTS (
    SELECT 1
    FROM outbox_dead_letters letter
    LEFT JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
    WHERE outbox.id IS NULL OR letter.tenant_id<>outbox.tenant_id OR letter.adapter<>outbox.adapter
       OR letter.kind<>outbox.kind
  ) OR EXISTS (
    SELECT 1
    FROM dead_letters letter
    LEFT JOIN deliveries delivery ON delivery.id=letter.delivery_id
    LEFT JOIN jobs job ON job.id=letter.job_id
    WHERE (letter.delivery_id IS NOT NULL AND (
             delivery.id IS NULL OR letter.tenant_id<>delivery.recipient_tenant
           ))
       OR (letter.job_id IS NOT NULL AND (
             job.id IS NULL OR letter.tenant_id<>job.tenant_id
           ))
  ) THEN
    RAISE EXCEPTION 'schema 030 refuses inconsistent causal DLQ/effect evidence';
  END IF;
END
$$;

ALTER TABLE telegram_egress_effects
  DROP CONSTRAINT IF EXISTS telegram_egress_effects_replay_generation_check,
  ADD CONSTRAINT telegram_egress_effects_replay_generation_check CHECK (
    replay_count>=0
    AND ((replay_count=0 AND replayed_at IS NULL) OR (replay_count>0 AND replayed_at IS NOT NULL))
  );

-- DLQ rows duplicate target coordinates for scoped operations.  Freeze that identity and validate
-- it at insertion so a projection cannot later move an incident across tenants.  INSERT takes the
-- referenced outbox row first; this also closes the race where an outbox identity UPDATE and a new
-- DLQ row would otherwise both observe that no causal evidence existed.
CREATE OR REPLACE FUNCTION cauce_fence_outbox_dead_letter_030()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  outbox_tenant text;
  outbox_adapter text;
  outbox_kind text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Durable outbox DLQ incidents must be resolved, never deleted';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.adapter IS DISTINCT FROM OLD.adapter
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Outbox DLQ causal coordinates are immutable';
    END IF;
    RETURN NEW;
  END IF;
  SELECT outbox.tenant_id,outbox.adapter,outbox.kind
    INTO outbox_tenant,outbox_adapter,outbox_kind
  FROM adapter_outbox outbox WHERE outbox.id=NEW.outbox_id FOR UPDATE;
  IF NOT FOUND OR NEW.tenant_id<>outbox_tenant OR NEW.adapter<>outbox_adapter
     OR NEW.kind<>outbox_kind THEN
    RAISE EXCEPTION 'Outbox DLQ incident does not match its causal outbox';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cauce_fence_outbox_dead_letter_030 ON outbox_dead_letters;
CREATE TRIGGER cauce_fence_outbox_dead_letter_030
BEFORE INSERT OR UPDATE OR DELETE ON outbox_dead_letters
FOR EACH ROW EXECUTE FUNCTION cauce_fence_outbox_dead_letter_030();

CREATE OR REPLACE FUNCTION cauce_fence_dead_letter_030()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_tenant text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Durable delivery/job DLQ incidents must be resolved, never deleted';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
       OR NEW.job_id IS DISTINCT FROM OLD.job_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Delivery/job DLQ causal coordinates are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.delivery_id IS NOT NULL THEN
    SELECT delivery.recipient_tenant INTO target_tenant
    FROM deliveries delivery WHERE delivery.id=NEW.delivery_id FOR SHARE;
  ELSE
    SELECT job.tenant_id INTO target_tenant
    FROM jobs job WHERE job.id=NEW.job_id FOR SHARE;
  END IF;
  IF NOT FOUND OR NEW.tenant_id<>target_tenant THEN
    RAISE EXCEPTION 'Delivery/job DLQ incident does not match its causal target';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cauce_fence_dead_letter_030 ON dead_letters;
CREATE TRIGGER cauce_fence_dead_letter_030
BEFORE INSERT OR UPDATE OR DELETE ON dead_letters
FOR EACH ROW EXECUTE FUNCTION cauce_fence_dead_letter_030();

-- Once an effect or DLQ incident exists, the outbox row is causal evidence.  Operational lease,
-- retry and terminal fields remain mutable; identity, routing, correlation and content do not.
CREATE OR REPLACE FUNCTION cauce_fence_adapter_outbox_causality_030()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (EXISTS (
        SELECT 1 FROM telegram_egress_effects effect WHERE effect.outbox_id=OLD.id
      ) OR EXISTS (
        SELECT 1 FROM outbox_dead_letters letter WHERE letter.outbox_id=OLD.id
      )) AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.adapter IS DISTINCT FROM OLD.adapter
        OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.request_id IS DISTINCT FROM OLD.request_id
        OR NEW.message_id IS DISTINCT FROM OLD.message_id
        OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
        OR NEW.trace_id IS DISTINCT FROM OLD.trace_id
        OR NEW.origin IS DISTINCT FROM OLD.origin
        OR NEW.payload IS DISTINCT FROM OLD.payload
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      ) THEN
    RAISE EXCEPTION 'Adapter outbox causal coordinates are immutable after effect or DLQ evidence';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cauce_fence_adapter_outbox_causality_030 ON adapter_outbox;
CREATE TRIGGER cauce_fence_adapter_outbox_causality_030
BEFORE UPDATE ON adapter_outbox
FOR EACH ROW EXECUTE FUNCTION cauce_fence_adapter_outbox_causality_030();

CREATE OR REPLACE FUNCTION cauce_fence_telegram_effect_030()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_outbox_id uuid;
  outbox_tenant text;
  outbox_adapter text;
  outbox_kind text;
  outbox_status text;
BEGIN
  effect_outbox_id := CASE WHEN TG_OP='DELETE' THEN OLD.outbox_id ELSE NEW.outbox_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended('telegram-effect:' || effect_outbox_id::text,0));
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Durable Telegram effect evidence cannot be deleted';
  END IF;
  SELECT tenant_id,adapter,kind,status
    INTO outbox_tenant,outbox_adapter,outbox_kind,outbox_status
  FROM adapter_outbox WHERE id=NEW.outbox_id FOR UPDATE;
  IF NOT FOUND OR NEW.tenant_id<>outbox_tenant
     OR outbox_adapter<>'telegram' OR outbox_kind<>'origin_relay' THEN
    RAISE EXCEPTION 'Telegram effect does not match its causal origin-relay outbox';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.outbox_id<>OLD.outbox_id OR NEW.effect_id<>OLD.effect_id
       OR NEW.tenant_id<>OLD.tenant_id OR NEW.bridge_alias<>OLD.bridge_alias
       OR NEW.chunk_index<>OLD.chunk_index OR NEW.chunk_count<>OLD.chunk_count
       OR NEW.payload_hash<>OLD.payload_hash THEN
      RAISE EXCEPTION 'Telegram effect causal coordinates are immutable';
    END IF;
    IF OLD.state='sent' AND (
      NEW.state<>'sent'
      OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
      OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    ) THEN
      RAISE EXCEPTION 'A durably sent Telegram effect is immutable';
    END IF;
    IF NEW.replay_count=OLD.replay_count THEN
      IF NEW.replayed_at IS DISTINCT FROM OLD.replayed_at THEN
        RAISE EXCEPTION 'Telegram effect replay generation timestamp is immutable';
      END IF;
    ELSIF NEW.replay_count=OLD.replay_count+1 THEN
      IF NEW.state<>'prepared' OR NEW.replayed_at IS NULL
         OR NEW.replayed_at IS NOT DISTINCT FROM OLD.replayed_at THEN
        RAISE EXCEPTION 'Telegram effect replay generation requires a new prepared transition';
      END IF;
    ELSE
      RAISE EXCEPTION 'Telegram effect replay generation must be monotonic';
    END IF;
  ELSIF TG_OP='INSERT' THEN
    IF outbox_status<>'processing' THEN
      RAISE EXCEPTION 'A new Telegram effect requires a live processing outbox';
    END IF;
    IF NEW.replay_count<>0 OR NEW.replayed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new Telegram effect must start at replay generation zero';
    END IF;
  END IF;
  IF NEW.state='sent' AND (
    NEW.provider_message_id IS NULL OR btrim(NEW.provider_message_id)=''
    OR NEW.sent_at IS NULL
  ) THEN
    RAISE EXCEPTION 'A sent Telegram effect requires durable provider acceptance and sent time';
  END IF;
  IF NEW.state='prepared' AND (
    NEW.sending_at IS NOT NULL OR NEW.provider_message_id IS NOT NULL OR NEW.sent_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A prepared Telegram effect cannot contain remote-call evidence';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cauce_fence_telegram_effect_030 ON telegram_egress_effects;
CREATE TRIGGER cauce_fence_telegram_effect_030
BEFORE INSERT OR UPDATE OR DELETE ON telegram_egress_effects
FOR EACH ROW EXECUTE FUNCTION cauce_fence_telegram_effect_030();

-- Direct delivery audit rows are causal proof.  Fence their insertion by delivery id and make the
-- proof immutable once written, so apply can bind one exact ordered audit set to its plan digest.
CREATE OR REPLACE FUNCTION cauce_fence_dlq_delivery_evidence_030()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_delivery_id uuid;
  evidence_action text;
BEGIN
  IF TG_OP='UPDATE' AND (
    (OLD.delivery_id IS NOT NULL AND OLD.action IN (
      'delivery.cancel','agent_output.materialize','agent_output.response','agent_output.fanin'
    )) OR (NEW.delivery_id IS NOT NULL AND NEW.action IN (
      'delivery.cancel','agent_output.materialize','agent_output.response','agent_output.fanin'
    ))
  ) THEN
    evidence_delivery_id := COALESCE(OLD.delivery_id,NEW.delivery_id);
    PERFORM pg_advisory_xact_lock(
      hashtextextended('dlq-delivery-evidence:' || evidence_delivery_id::text,0)
    );
    IF OLD.id<>NEW.id OR OLD.delivery_id IS DISTINCT FROM NEW.delivery_id
       OR OLD.action IS DISTINCT FROM NEW.action OR OLD.decision IS DISTINCT FROM NEW.decision THEN
      RAISE EXCEPTION 'Causal delivery audit identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  evidence_delivery_id := CASE WHEN TG_OP='DELETE' THEN OLD.delivery_id ELSE NEW.delivery_id END;
  evidence_action := CASE WHEN TG_OP='DELETE' THEN OLD.action ELSE NEW.action END;
  IF evidence_delivery_id IS NULL OR evidence_action NOT IN (
    'delivery.cancel','agent_output.materialize','agent_output.response','agent_output.fanin'
  ) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('dlq-delivery-evidence:' || evidence_delivery_id::text,0)
  );
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Causal delivery audit evidence is immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cauce_fence_dlq_delivery_evidence_030 ON audit_events;
CREATE TRIGGER cauce_fence_dlq_delivery_evidence_030
BEFORE INSERT OR UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION cauce_fence_dlq_delivery_evidence_030();

-- Internal candidate relation.  It returns identifiers only to database-side callers; the CLI
-- exposes exclusively the aggregates and hashes produced by cauce_dlq_plan_material_030().
CREATE OR REPLACE FUNCTION cauce_dlq_candidates_030()
RETURNS TABLE(
  target text,
  dead_letter_id uuid,
  rule text,
  from_disposition text,
  to_disposition text,
  evidence_sha256 text,
  causal_key text,
  target_tenant text
)
LANGUAGE sql
STABLE
AS $$
WITH effect_summary AS (
  SELECT effect.outbox_id,
         count(*)::integer AS effect_count,
         count(DISTINCT effect.chunk_count)::integer AS chunk_count_variants,
         min(effect.chunk_count)::integer AS declared_chunks,
         count(DISTINCT effect.chunk_index)::integer AS distinct_indices,
         min(effect.chunk_index)::integer AS first_chunk,
         max(effect.chunk_index)::integer AS last_chunk,
         bool_and(
           effect.state='sent'
           AND effect.provider_message_id IS NOT NULL
           AND btrim(effect.provider_message_id)<>''
           AND effect.sent_at IS NOT NULL
         ) AS every_chunk_sent,
         bool_or(effect.state IN ('sending','ambiguous')) AS has_ambiguous,
         bool_or(effect.state='dead') AS has_dead,
         bool_or(effect.state='prepared') AS has_prepared,
         bool_and(effect.state IN ('prepared','sent')) AS only_prepared_or_sent,
         count(DISTINCT effect.provider_message_id)::integer AS distinct_provider_messages,
         max(effect.sent_at) AS last_sent_at,
         encode(digest(convert_to(jsonb_agg(jsonb_build_array(
           effect.chunk_index,effect.chunk_count,effect.payload_hash,effect.state,
           effect.provider_message_id,effect.sent_at
         ) ORDER BY effect.chunk_index)::text,'UTF8'),'sha256'),'hex') AS effect_digest
  FROM telegram_egress_effects effect
  GROUP BY effect.outbox_id
), outbox_base AS (
  SELECT letter.id AS dead_letter_id,letter.disposition,letter.disposition_at,
         letter.reopen_count,
         outbox.id AS outbox_id,outbox.tenant_id,outbox.adapter,outbox.kind,outbox.status,
         outbox.delivery_id,outbox.created_at,outbox.payload,outbox.attempts AS outbox_attempts,
         COALESCE(
           outbox.payload#>>'{correlation,root_message_id}',
           outbox.payload#>>'{correlation,message_id}'
         ) AS causal_key,
         delivery.status AS delivery_status,delivery.terminal_at,
         effects.effect_count,effects.chunk_count_variants,effects.declared_chunks,
         effects.distinct_indices,effects.first_chunk,effects.last_chunk,effects.every_chunk_sent,
         effects.has_ambiguous,effects.has_dead,effects.has_prepared,effects.only_prepared_or_sent,
         effects.last_sent_at,effects.effect_digest,
         effects.distinct_provider_messages,
         final_proof.proven AS final_proven,final_proof.proof_digest AS final_digest,
         later_wake.proven AS later_wake_proven,later_wake.proof_digest AS later_wake_digest,
         (EXISTS (
           SELECT 1 FROM agents agent
           WHERE agent.tenant_id=delivery.recipient_tenant
             AND agent.alias=delivery.recipient_alias
         ) AND NOT EXISTS (
           SELECT 1 FROM agents agent
           WHERE agent.tenant_id=delivery.recipient_tenant
             AND agent.alias=delivery.recipient_alias AND agent.enabled
         )) OR (EXISTS (
           SELECT 1 FROM memberships member
           WHERE member.tenant_id=delivery.recipient_tenant
             AND member.alias=delivery.recipient_alias
         ) AND NOT EXISTS (
           SELECT 1 FROM memberships member
           WHERE member.tenant_id=delivery.recipient_tenant
             AND member.alias=delivery.recipient_alias AND member.enabled
         )) AS recipient_disabled
  FROM outbox_dead_letters letter
  JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
  LEFT JOIN deliveries delivery ON delivery.id=outbox.delivery_id
  LEFT JOIN effect_summary effects ON effects.outbox_id=outbox.id
  LEFT JOIN LATERAL (
    SELECT count(*)>0 AS proven,
           encode(digest(convert_to(jsonb_agg(jsonb_build_array(
             final.id,final.status,final.attempts,final.claimed_at
           ) ORDER BY final.id)::text,'UTF8'),'sha256'),'hex') AS proof_digest
    FROM adapter_outbox final
    WHERE outbox.adapter='telegram' AND outbox.kind='origin_relay'
      AND outbox.payload->>'relay_kind'='ack'
      AND final.tenant_id=outbox.tenant_id
      AND final.adapter=outbox.adapter AND final.kind=outbox.kind AND final.id<>outbox.id
      AND final.payload->>'relay_kind' IS DISTINCT FROM 'ack'
      AND COALESCE(
        final.payload#>>'{correlation,root_message_id}',
        final.payload#>>'{correlation,message_id}'
      )=COALESCE(
        outbox.payload#>>'{correlation,root_message_id}',
        outbox.payload#>>'{correlation,message_id}'
      )
      AND (
        final.attempts>0 OR final.status IN ('sent','dead')
        OR (final.status='processing' AND final.claimed_at IS NOT NULL)
      )
  ) final_proof ON true
  LEFT JOIN LATERAL (
    SELECT count(*)>0 AS proven,
           encode(digest(convert_to(jsonb_agg(jsonb_build_array(
             later.id,later.status,later.attempts,later.sent_at
           ) ORDER BY later.created_at,later.id)::text,'UTF8'),'sha256'),'hex') AS proof_digest
    FROM adapter_outbox later
    WHERE outbox.kind='wake' AND outbox.delivery_id IS NOT NULL
      AND later.kind='wake' AND later.delivery_id=outbox.delivery_id
      AND later.status='sent'
      AND (later.created_at,later.id)>(outbox.created_at,outbox.id)
  ) later_wake ON true
  WHERE letter.resolved_at IS NULL
), outbox_resolution AS (
  SELECT base.*,
         CASE
           WHEN adapter='telegram' AND kind='origin_relay' AND status='dead'
             AND effect_count>0 AND chunk_count_variants=1
             AND declared_chunks=effect_count AND distinct_indices=effect_count
             AND first_chunk=0 AND last_chunk=effect_count-1 AND every_chunk_sent
             AND (declared_chunks=1 OR distinct_provider_messages=effect_count)
             THEN 'telegram_exact_sent_v1'
           WHEN adapter='telegram' AND kind='origin_relay' AND status='dead'
             AND payload->>'relay_kind'='ack' AND causal_key IS NOT NULL AND final_proven
             THEN 'telegram_ack_final_claimed_v1'
           WHEN kind='wake' AND status='dead' AND delivery_id IS NOT NULL
             AND terminal_at IS NOT NULL AND delivery_status IN ('done','failed','dead')
             THEN 'wake_delivery_terminal_v1'
           WHEN kind='wake' AND status='dead' AND delivery_id IS NOT NULL AND later_wake_proven
             THEN 'wake_later_sent_v1'
           WHEN kind='wake' AND status='dead' AND delivery_id IS NOT NULL AND recipient_disabled
             THEN 'wake_expected_offline_v1'
           ELSE NULL
         END AS resolution_rule
  FROM outbox_base base
), resolution_candidates AS (
  SELECT 'outbox'::text AS target,dead_letter_id,resolution_rule AS rule,
         disposition AS from_disposition,
         CASE WHEN resolution_rule='wake_expected_offline_v1'
           THEN 'expected_offline' ELSE disposition END::text AS to_disposition,
         encode(digest(convert_to(concat_ws('|',
           resolution_rule,dead_letter_id::text,outbox_id::text,status,
           reopen_count::text,outbox_attempts::text,
           CASE resolution_rule
             WHEN 'telegram_exact_sent_v1' THEN effect_digest
             WHEN 'telegram_ack_final_claimed_v1' THEN final_digest
             WHEN 'wake_delivery_terminal_v1' THEN concat_ws(':',delivery_id::text,delivery_status,terminal_at::text)
             WHEN 'wake_later_sent_v1' THEN later_wake_digest
             WHEN 'wake_expected_offline_v1' THEN concat_ws(':',delivery_id::text,'recipient-disabled')
             ELSE ''
           END
         ),'UTF8'),'sha256'),'hex') AS evidence_sha256,
         causal_key,tenant_id AS target_tenant
  FROM outbox_resolution WHERE resolution_rule IS NOT NULL
), outbox_classification AS (
  SELECT 'outbox'::text AS target,base.dead_letter_id,
         ('classify_' || desired.disposition || '_v1')::text AS rule,
         base.disposition AS from_disposition,desired.disposition AS to_disposition,
         encode(digest(convert_to(concat_ws('|',
           'classify',base.dead_letter_id::text,base.outbox_id::text,base.status,
           base.reopen_count::text,base.outbox_attempts::text,
           desired.disposition,COALESCE(base.effect_digest,''),
           COALESCE(base.delivery_id::text,''),COALESCE(base.delivery_status,'')
         ),'UTF8'),'sha256'),'hex') AS evidence_sha256,
         base.causal_key,base.tenant_id AS target_tenant
  FROM outbox_resolution base
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN base.adapter='telegram' AND base.kind='origin_relay'
        AND COALESCE(base.has_ambiguous,false) THEN 'ambiguous'
      WHEN base.adapter='telegram' AND base.kind='origin_relay'
        AND COALESCE(base.has_dead,false) THEN 'safe_retry'
      WHEN base.adapter='telegram' AND base.kind='origin_relay'
        AND COALESCE(base.has_prepared,false) AND COALESCE(base.only_prepared_or_sent,false)
        THEN 'safe_retry'
      WHEN base.adapter='telegram' AND base.kind='origin_relay'
        AND COALESCE(base.effect_count,0)=0 THEN 'missing_final'
      WHEN base.kind='wake' AND base.delivery_id IS NULL THEN 'missing_final'
      WHEN base.kind='wake' AND base.recipient_disabled THEN 'expected_offline'
      ELSE 'unclassified'
    END::text AS disposition
  ) desired
  WHERE base.resolution_rule IS NULL
    AND base.disposition='unclassified' AND base.disposition_at IS NULL
), delivery_base AS (
  SELECT letter.id AS dead_letter_id,letter.tenant_id,letter.disposition,letter.disposition_at,
         delivery.id AS delivery_id,delivery.status,delivery.attempt,delivery.terminal_at,
         delivery.execution_started_at,delivery.recipient_tenant,delivery.recipient_alias,
         (EXISTS (
           SELECT 1 FROM agents agent
           WHERE agent.tenant_id=delivery.recipient_tenant
             AND agent.alias=delivery.recipient_alias
         ) AND NOT EXISTS (
           SELECT 1 FROM agents agent
           WHERE agent.tenant_id=delivery.recipient_tenant
             AND agent.alias=delivery.recipient_alias AND agent.enabled
         )) AS agent_disabled,
         (EXISTS (
           SELECT 1 FROM memberships member
           WHERE member.tenant_id=delivery.recipient_tenant
             AND member.alias=delivery.recipient_alias
         ) AND NOT EXISTS (
           SELECT 1 FROM memberships member
           WHERE member.tenant_id=delivery.recipient_tenant
             AND member.alias=delivery.recipient_alias AND member.enabled
         )) AS membership_disabled,
         proof.rule AS audit_rule,proof.audit_digest
  FROM dead_letters letter
  LEFT JOIN deliveries delivery ON delivery.id=letter.delivery_id
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN bool_or(audit.action='delivery.cancel') THEN 'delivery_cancelled_v1'
             WHEN bool_or(audit.action IN (
               'agent_output.materialize','agent_output.response','agent_output.fanin'
             )) THEN 'delivery_terminal_notice_materialized_v1'
             ELSE NULL
           END::text AS rule,
           encode(digest(convert_to(COALESCE(string_agg(
             audit.id::text || ':' || audit.action,'|' ORDER BY audit.id,audit.action
           ),''),'UTF8'),'sha256'),'hex') AS audit_digest
    FROM audit_events audit
    WHERE audit.delivery_id=delivery.id AND audit.decision='allow'
      AND audit.action IN (
        'delivery.cancel','agent_output.materialize','agent_output.response','agent_output.fanin'
      )
  ) proof ON true
  WHERE letter.resolved_at IS NULL
), delivery_resolution AS (
  SELECT 'delivery'::text AS target,base.dead_letter_id,desired.rule,
         base.disposition AS from_disposition,
         CASE WHEN desired.rule='delivery_expected_offline_v1'
           THEN 'expected_offline' ELSE base.disposition END::text AS to_disposition,
         encode(digest(convert_to(concat_ws('|',
           desired.rule,base.dead_letter_id::text,base.delivery_id::text,
           base.status,base.terminal_at::text,
           CASE WHEN desired.rule='delivery_expected_offline_v1'
             THEN concat_ws(':',base.recipient_tenant,base.recipient_alias,
               base.agent_disabled::text,base.membership_disabled::text)
             ELSE base.audit_digest
           END
         ),'UTF8'),'sha256'),'hex') AS evidence_sha256,
         NULL::text AS causal_key,base.tenant_id AS target_tenant
  FROM delivery_base base
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN base.audit_rule IS NOT NULL THEN base.audit_rule
      WHEN base.execution_started_at IS NULL
        AND (base.agent_disabled OR base.membership_disabled)
        THEN 'delivery_expected_offline_v1'
      ELSE NULL
    END::text AS rule
  ) desired
  WHERE base.delivery_id IS NOT NULL
    AND base.terminal_at IS NOT NULL AND base.status IN ('done','failed','dead')
    AND desired.rule IS NOT NULL
), delivery_classification AS (
  SELECT 'delivery'::text AS target,base.dead_letter_id,
         ('classify_' || desired.disposition || '_v1')::text AS rule,
         base.disposition AS from_disposition,desired.disposition AS to_disposition,
         encode(digest(convert_to(concat_ws('|',
           'classify',base.dead_letter_id::text,COALESCE(base.delivery_id::text,''),
           COALESCE(base.status,''),COALESCE(base.attempt::text,''),
           COALESCE((base.execution_started_at IS NOT NULL)::text,''),
           desired.disposition
         ),'UTF8'),'sha256'),'hex') AS evidence_sha256,
         NULL::text AS causal_key,base.tenant_id AS target_tenant
  FROM delivery_base base
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN base.delivery_id IS NULL THEN 'missing_final'
      WHEN base.execution_started_at IS NOT NULL THEN 'ambiguous'
      WHEN base.status IN ('dead','failed') THEN 'safe_retry'
      ELSE 'unclassified'
    END::text AS disposition
  ) desired
  WHERE base.disposition='unclassified' AND base.disposition_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM delivery_resolution resolution
      WHERE resolution.dead_letter_id=base.dead_letter_id
    )
)
SELECT * FROM resolution_candidates
UNION ALL
SELECT * FROM outbox_classification
UNION ALL
SELECT * FROM delivery_resolution
UNION ALL
SELECT * FROM delivery_classification
$$;

CREATE OR REPLACE FUNCTION cauce_dlq_snapshot_030(
  p_actor_tenant text,
  p_actor_alias text
) RETURNS jsonb
LANGUAGE sql
VOLATILE
AS $$
WITH visible_inventory AS MATERIALIZED (
  SELECT 'delivery'::text AS source,
         CASE WHEN letter.delivery_id IS NOT NULL THEN 'delivery' ELSE 'job' END::text AS kind,
         letter.disposition,letter.resolved_at IS NULL AS open,
         letter.resolved_at IS NULL
           AND letter.disposition IN ('ambiguous','safe_retry','missing_final','auth') AS actionable
  FROM dead_letters letter
  WHERE cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
  UNION ALL
  SELECT 'outbox'::text,letter.kind,letter.disposition,letter.resolved_at IS NULL,
         letter.resolved_at IS NULL
           AND letter.disposition IN ('ambiguous','safe_retry','missing_final','auth')
  FROM outbox_dead_letters letter
  WHERE cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
), inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'source',source,'kind',kind,'disposition',disposition,
    'open',open,'actionable',actionable,'count',count
  ) ORDER BY source,kind,disposition,open,actionable),'[]'::jsonb) AS value
  FROM (
    SELECT source,kind,disposition,open,actionable,count(*)::bigint AS count
    FROM visible_inventory
    GROUP BY source,kind,disposition,open,actionable
  ) grouped_inventory
), candidates AS MATERIALIZED (
  SELECT * FROM cauce_dlq_candidates_030() candidate
  WHERE cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,candidate.target_tenant)
), transition_groups AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'target',target,'rule',rule,'toDisposition',to_disposition,'count',count,
    'evidenceSha256',evidence_sha256
  ) ORDER BY target,rule,to_disposition),'[]'::jsonb) AS value
  FROM (
    SELECT target,rule,to_disposition,count(*)::bigint AS count,
           encode(digest(convert_to(string_agg(evidence_sha256,'|' ORDER BY evidence_sha256),'UTF8'),'sha256'),'hex')
             AS evidence_sha256
    FROM candidates GROUP BY target,rule,to_disposition
  ) grouped
), candidate_set AS (
  SELECT count(*)::bigint AS count,
         encode(digest(convert_to(COALESCE(string_agg(
           concat_ws('|',target,target_tenant,dead_letter_id::text,rule,evidence_sha256),
           E'\n' ORDER BY target,dead_letter_id,rule,evidence_sha256
         ),''),'UTF8'),'sha256'),'hex') AS digest
  FROM candidates
), candidate_rows AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'target',target,'dead_letter_id',dead_letter_id,'rule',rule,
    'from_disposition',from_disposition,'to_disposition',to_disposition,
    'evidence_sha256',evidence_sha256,'causal_key',causal_key,
    'target_tenant',target_tenant
  ) ORDER BY target,dead_letter_id,rule),'[]'::jsonb) AS value
  FROM candidates
)
SELECT jsonb_build_object(
  'material',jsonb_build_object(
    'schemaVersion',1,
    'actorSha256',encode(digest(convert_to(p_actor_tenant || chr(31) || p_actor_alias,'UTF8'),'sha256'),'hex'),
    'candidateCount',candidate_set.count,
    'candidateSetSha256',candidate_set.digest,
    'inventory',inventory.value,
    'transitions',transition_groups.value
  ),
  'candidates',candidate_rows.value
)
FROM inventory,transition_groups,candidate_set,candidate_rows
$$;

CREATE OR REPLACE FUNCTION cauce_dlq_plan_material_030(
  p_actor_tenant text,
  p_actor_alias text
) RETURNS jsonb
LANGUAGE sql
VOLATILE
AS $$
SELECT cauce_dlq_snapshot_030(p_actor_tenant,p_actor_alias)->'material'
$$;

CREATE OR REPLACE FUNCTION cauce_dlq_inspect_030(
  p_actor_tenant text,
  p_actor_alias text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  material jsonb;
BEGIN
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  PERFORM pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));
  material := cauce_dlq_plan_material_030(p_actor_tenant,p_actor_alias);
  RETURN jsonb_build_object(
    'schemaVersion',1,
    'suite','cauce-v3-dlq-causal-reconciliation',
    'phase','inspect',
    'inventory',material->'inventory',
    'inventorySha256',encode(digest(convert_to((material->'inventory')::text,'UTF8'),'sha256'),'hex')
  );
END
$$;

CREATE OR REPLACE FUNCTION cauce_dlq_plan_030(
  p_actor_tenant text,
  p_actor_alias text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  material jsonb;
  plan_sha256 text;
BEGIN
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  PERFORM pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));
  material := cauce_dlq_plan_material_030(p_actor_tenant,p_actor_alias);
  plan_sha256 := encode(digest(convert_to(material::text,'UTF8'),'sha256'),'hex');
  RETURN jsonb_build_object(
    'schemaVersion',1,
    'suite','cauce-v3-dlq-causal-reconciliation',
    'phase','plan',
    'planSha256',plan_sha256,
    'material',material
  );
END
$$;

CREATE OR REPLACE FUNCTION cauce_dlq_apply_030(
  p_actor_tenant text,
  p_actor_alias text,
  p_expected_plan_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  candidate record;
  causal record;
  effect_outbox record;
  delivery_evidence record;
  material jsonb;
  apply_snapshot jsonb;
  observed_plan_sha256 text;
  actor_sha256 text;
  audit_id bigint;
  changed integer;
  transitions integer := 0;
  resolved integer := 0;
  recovered_sent integer := 0;
  dispositions integer := 0;
  proven_sent_at timestamptz;
  previous_run dlq_reconciliation_runs%ROWTYPE;
BEGIN
  IF p_expected_plan_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'DLQ reconciliation requires a canonical plan digest';
  END IF;
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  PERFORM pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));
  -- Candidate rows and material are captured by one statement below.  Iterating that immutable
  -- snapshot prevents a later READ COMMITTED statement from applying an unapproved new incident,
  -- without a table lock that would invert the effect-writer advisory fence.
  PERFORM 1
  FROM memberships membership
  JOIN role_policies role ON role.role=membership.role
  JOIN tenants tenant ON tenant.id=membership.tenant_id
  JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
  WHERE membership.tenant_id=p_actor_tenant AND membership.alias=p_actor_alias
  ORDER BY membership.room_id
  FOR SHARE OF membership,role,tenant,room;
  PERFORM 1 FROM acl_edges edge
  WHERE edge.from_tenant=p_actor_tenant
  ORDER BY edge.to_tenant FOR SHARE OF edge;
  PERFORM 1 FROM tenants scoped_tenant
  WHERE scoped_tenant.id=p_actor_tenant OR EXISTS (
    SELECT 1 FROM acl_edges edge
    WHERE edge.from_tenant=p_actor_tenant AND edge.to_tenant=scoped_tenant.id
  )
  ORDER BY scoped_tenant.id FOR SHARE OF scoped_tenant;
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  actor_sha256 := encode(digest(convert_to(p_actor_tenant || chr(31) || p_actor_alias,'UTF8'),'sha256'),'hex');

  SELECT * INTO previous_run FROM dlq_reconciliation_runs
  WHERE plan_sha256=p_expected_plan_sha256 FOR UPDATE;
  IF FOUND THEN
    IF previous_run.actor_sha256<>actor_sha256 THEN
      RAISE EXCEPTION 'DLQ reconciliation plan belongs to a different actor';
    END IF;
    RETURN jsonb_build_object(
      'schemaVersion',1,'suite','cauce-v3-dlq-causal-reconciliation','phase','apply',
      'planSha256',p_expected_plan_sha256,'alreadyApplied',true,
      'transitionCount',0,'resolvedCount',0,'recoveredSentCount',0,'dispositionCount',0
    );
  END IF;

  -- Runtime Telegram claims use this same causal lock key.  Taking keys in lexical order avoids
  -- deadlocks when one plan contains more than one conversation.
  FOR causal IN
    SELECT DISTINCT causal_key FROM cauce_dlq_candidates_030() scoped_candidate
    WHERE causal_key IS NOT NULL
      AND cauce_dlq_lock_control_tenant_030(
        p_actor_tenant,p_actor_alias,scoped_candidate.target_tenant
      )
    ORDER BY causal_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('telegram-origin-relay:' || causal.causal_key,0));
  END LOOP;
  FOR effect_outbox IN
    SELECT DISTINCT outbox.id
    FROM outbox_dead_letters letter
    JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
    WHERE letter.resolved_at IS NULL
      AND outbox.adapter='telegram' AND outbox.kind='origin_relay'
      AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
    ORDER BY outbox.id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('telegram-effect:' || effect_outbox.id::text,0)
    );
  END LOOP;

  PERFORM 1
  FROM outbox_dead_letters letter
  JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
  WHERE letter.resolved_at IS NULL
    AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
  ORDER BY letter.id FOR UPDATE OF letter,outbox;
  PERFORM 1 FROM adapter_outbox sibling
  WHERE EXISTS (
    SELECT 1 FROM outbox_dead_letters letter
    JOIN adapter_outbox base ON base.id=letter.outbox_id
    WHERE letter.resolved_at IS NULL
      AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
      AND (
        (base.kind='wake' AND base.delivery_id IS NOT NULL
          AND sibling.kind='wake' AND sibling.delivery_id=base.delivery_id)
        OR (
          base.adapter='telegram' AND base.kind='origin_relay'
          AND sibling.tenant_id=base.tenant_id
          AND sibling.adapter=base.adapter AND sibling.kind=base.kind
          AND COALESCE(
            base.payload#>>'{correlation,root_message_id}',
            base.payload#>>'{correlation,message_id}'
          ) IS NOT NULL
          AND COALESCE(
            sibling.payload#>>'{correlation,root_message_id}',
            sibling.payload#>>'{correlation,message_id}'
          )=COALESCE(
            base.payload#>>'{correlation,root_message_id}',
            base.payload#>>'{correlation,message_id}'
          )
        )
      )
  )
  ORDER BY sibling.id FOR UPDATE OF sibling;
  PERFORM 1
  FROM telegram_egress_effects effect
  JOIN adapter_outbox outbox ON outbox.id=effect.outbox_id
  JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
  WHERE letter.resolved_at IS NULL
    AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
  ORDER BY effect.effect_id FOR UPDATE OF effect;
  PERFORM 1 FROM deliveries delivery
  JOIN dead_letters letter ON letter.delivery_id=delivery.id
  WHERE letter.resolved_at IS NULL
    AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
  ORDER BY delivery.id FOR UPDATE OF delivery;
  PERFORM 1 FROM deliveries delivery
  WHERE EXISTS (
    SELECT 1 FROM outbox_dead_letters letter
    JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
    WHERE letter.resolved_at IS NULL AND outbox.delivery_id=delivery.id
      AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
  )
  ORDER BY delivery.id FOR UPDATE OF delivery;
  PERFORM 1 FROM dead_letters letter
  WHERE letter.resolved_at IS NULL
    AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
  ORDER BY letter.id FOR UPDATE OF letter;
  FOR delivery_evidence IN
    SELECT DISTINCT letter.delivery_id
    FROM dead_letters letter
    WHERE letter.resolved_at IS NULL AND letter.delivery_id IS NOT NULL
      AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
    ORDER BY letter.delivery_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('dlq-delivery-evidence:' || delivery_evidence.delivery_id::text,0)
    );
  END LOOP;

  -- Expected-offline is causal only while the exact recipient rows remain disabled.  Share-lock
  -- them before recomputing the plan so a concurrent re-enable either wins first (stale plan) or
  -- waits until this fenced transition commits.
  PERFORM 1 FROM agents agent
  WHERE EXISTS (
    SELECT 1 FROM dead_letters letter JOIN deliveries delivery ON delivery.id=letter.delivery_id
    WHERE letter.resolved_at IS NULL
      AND delivery.recipient_tenant=agent.tenant_id AND delivery.recipient_alias=agent.alias
      AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
    UNION ALL
    SELECT 1 FROM outbox_dead_letters letter
    JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
    JOIN deliveries delivery ON delivery.id=outbox.delivery_id
    WHERE letter.resolved_at IS NULL
      AND delivery.recipient_tenant=agent.tenant_id AND delivery.recipient_alias=agent.alias
      AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
  )
  ORDER BY agent.tenant_id,agent.alias FOR SHARE OF agent;
  PERFORM 1 FROM memberships membership
  WHERE EXISTS (
    SELECT 1 FROM dead_letters letter JOIN deliveries delivery ON delivery.id=letter.delivery_id
    WHERE letter.resolved_at IS NULL
      AND delivery.recipient_tenant=membership.tenant_id
      AND delivery.recipient_alias=membership.alias
      AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
    UNION ALL
    SELECT 1 FROM outbox_dead_letters letter
    JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
    JOIN deliveries delivery ON delivery.id=outbox.delivery_id
    WHERE letter.resolved_at IS NULL
      AND delivery.recipient_tenant=membership.tenant_id
      AND delivery.recipient_alias=membership.alias
      AND cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
  )
  ORDER BY membership.tenant_id,membership.alias,membership.room_id FOR SHARE OF membership;

  apply_snapshot := cauce_dlq_snapshot_030(p_actor_tenant,p_actor_alias);
  material := apply_snapshot->'material';
  observed_plan_sha256 := encode(digest(convert_to(material::text,'UTF8'),'sha256'),'hex');
  IF observed_plan_sha256<>p_expected_plan_sha256 THEN
    RAISE EXCEPTION 'DLQ reconciliation plan is stale';
  END IF;

  FOR candidate IN
    SELECT *
    FROM jsonb_to_recordset(apply_snapshot->'candidates') AS captured(
      target text,dead_letter_id uuid,rule text,from_disposition text,to_disposition text,
      evidence_sha256 text,causal_key text,target_tenant text
    )
    ORDER BY target,dead_letter_id,rule
  LOOP
    IF candidate.dead_letter_id IS NULL OR candidate.target_tenant IS NULL
       OR candidate.rule IS NULL OR candidate.from_disposition IS NULL
       OR candidate.to_disposition IS NULL OR candidate.evidence_sha256 IS NULL THEN
      RAISE EXCEPTION 'DLQ apply captured an invalid candidate snapshot';
    END IF;
    IF EXISTS (
      SELECT 1 FROM dlq_reconciliation_transitions transition
      WHERE transition.target=candidate.target
        AND transition.dead_letter_id=candidate.dead_letter_id
        AND transition.rule=candidate.rule
        AND transition.evidence_sha256=candidate.evidence_sha256
    ) THEN
      CONTINUE;
    END IF;

    changed := 0;
    IF candidate.rule='telegram_exact_sent_v1' THEN
      SELECT max(effect.sent_at) INTO proven_sent_at
      FROM telegram_egress_effects effect
      JOIN outbox_dead_letters letter ON letter.outbox_id=effect.outbox_id
      WHERE letter.id=candidate.dead_letter_id;
      UPDATE adapter_outbox outbox SET
        status='sent',sent_at=proven_sent_at,dead_at=NULL,claimed_by=NULL,claim_token=NULL,
        claim_expires_at=NULL,last_error=NULL
      FROM outbox_dead_letters letter
      WHERE letter.id=candidate.dead_letter_id AND letter.outbox_id=outbox.id
        AND letter.resolved_at IS NULL AND outbox.status='dead';
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed=1 THEN
        UPDATE outbox_dead_letters SET
          resolved_at=now(),resolution_rule=candidate.rule,
          evidence_sha256=candidate.evidence_sha256,
          disposition=candidate.to_disposition,disposition_at=now()
        WHERE id=candidate.dead_letter_id AND resolved_at IS NULL;
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed<>1 THEN RAISE EXCEPTION 'DLQ exact-sent resolution lost its CAS'; END IF;
        recovered_sent := recovered_sent + 1;
        resolved := resolved + 1;
      END IF;
    ELSIF candidate.rule IN (
      'telegram_ack_final_claimed_v1','wake_delivery_terminal_v1','wake_later_sent_v1',
      'wake_expected_offline_v1'
    ) THEN
      UPDATE outbox_dead_letters SET
        resolved_at=now(),resolution_rule=candidate.rule,
        evidence_sha256=candidate.evidence_sha256,
        disposition=candidate.to_disposition,disposition_at=now()
      WHERE id=candidate.dead_letter_id AND resolved_at IS NULL;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed=1 THEN resolved := resolved + 1; END IF;
    ELSIF candidate.target='delivery' AND candidate.rule IN (
      'delivery_terminal_notice_materialized_v1','delivery_cancelled_v1',
      'delivery_expected_offline_v1'
    ) THEN
      UPDATE dead_letters SET
        resolved_at=now(),resolution_rule=candidate.rule,
        evidence_sha256=candidate.evidence_sha256,
        disposition=candidate.to_disposition,disposition_at=now()
      WHERE id=candidate.dead_letter_id AND resolved_at IS NULL;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed=1 THEN resolved := resolved + 1; END IF;
    ELSIF candidate.target='outbox' AND left(candidate.rule,9)='classify_' THEN
      UPDATE outbox_dead_letters SET
        disposition=candidate.to_disposition,disposition_at=now(),
        evidence_sha256=candidate.evidence_sha256
      WHERE id=candidate.dead_letter_id AND resolved_at IS NULL
        AND disposition=candidate.from_disposition AND disposition_at IS NULL;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed=1 THEN dispositions := dispositions + 1; END IF;
    ELSIF candidate.target='delivery' AND left(candidate.rule,9)='classify_' THEN
      UPDATE dead_letters SET
        disposition=candidate.to_disposition,disposition_at=now(),
        evidence_sha256=candidate.evidence_sha256
      WHERE id=candidate.dead_letter_id AND resolved_at IS NULL
        AND disposition=candidate.from_disposition AND disposition_at IS NULL;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed=1 THEN dispositions := dispositions + 1; END IF;
    END IF;

    IF changed=1 THEN
      transitions := transitions + 1;
      INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
      VALUES(
        candidate.target_tenant,p_actor_alias,'dlq.reconcile','info',
        jsonb_build_object(
          'schema_version',1,'rule',candidate.rule,
          'actor_sha256',actor_sha256,
          'counts',jsonb_build_object(
            'transitions',1,
            'resolved',CASE WHEN left(candidate.rule,9)='classify_' THEN 0 ELSE 1 END,
            'recovered_sent',CASE WHEN candidate.rule='telegram_exact_sent_v1' THEN 1 ELSE 0 END,
            'dispositions',CASE WHEN left(candidate.rule,9)='classify_' THEN 1 ELSE 0 END
          ),
          'evidence_sha256',candidate.evidence_sha256,
          'plan_sha256',p_expected_plan_sha256
        )
      ) RETURNING id INTO audit_id;
      INSERT INTO dlq_reconciliation_transitions(
        target,dead_letter_id,rule,actor_tenant,actor_alias,evidence_sha256,
        from_disposition,to_disposition,resolved,audit_event_id
      ) VALUES(
        candidate.target,candidate.dead_letter_id,candidate.rule,p_actor_tenant,p_actor_alias,
        candidate.evidence_sha256,candidate.from_disposition,candidate.to_disposition,
        left(candidate.rule,9)<>'classify_',audit_id
      );
    END IF;
  END LOOP;

  INSERT INTO dlq_reconciliation_runs(
    plan_sha256,actor_sha256,transition_count,resolved_count,recovered_sent_count,disposition_count
  ) VALUES(
    p_expected_plan_sha256,actor_sha256,transitions,resolved,recovered_sent,dispositions
  );
  RETURN jsonb_build_object(
    'schemaVersion',1,'suite','cauce-v3-dlq-causal-reconciliation','phase','apply',
    'planSha256',p_expected_plan_sha256,'alreadyApplied',false,
    'transitionCount',transitions,'resolvedCount',resolved,
    'recoveredSentCount',recovered_sent,'dispositionCount',dispositions
  );
END
$$;

CREATE OR REPLACE FUNCTION cauce_dlq_post_030(
  p_actor_tenant text,
  p_actor_alias text,
  p_plan_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  inspected jsonb;
  run dlq_reconciliation_runs%ROWTYPE;
  actor_sha256 text;
BEGIN
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  PERFORM pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));
  actor_sha256 := encode(digest(convert_to(p_actor_tenant || chr(31) || p_actor_alias,'UTF8'),'sha256'),'hex');
  SELECT * INTO run FROM dlq_reconciliation_runs WHERE plan_sha256=p_plan_sha256;
  IF NOT FOUND OR run.actor_sha256<>actor_sha256 THEN
    RAISE EXCEPTION 'DLQ reconciliation post gate has no matching applied plan';
  END IF;
  inspected := cauce_dlq_inspect_030(p_actor_tenant,p_actor_alias);
  RETURN jsonb_build_object(
    'schemaVersion',1,'suite','cauce-v3-dlq-causal-reconciliation','phase','post',
    'planSha256',p_plan_sha256,
    'appliedCounts',jsonb_build_object(
      'transitions',run.transition_count,'resolved',run.resolved_count,
      'recoveredSent',run.recovered_sent_count,'dispositions',run.disposition_count
    ),
    'inventory',inspected->'inventory','inventorySha256',inspected->'inventorySha256'
  );
END
$$;

-- Re-open the same durable incident after an explicitly scheduled replay fails again.  The unique
-- DLQ row is preserved; reopen_count/last_reopened_at plus the manual-replay ledger retain history.
CREATE OR REPLACE FUNCTION cauce_reopen_outbox_dead_letter_030()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  letter_id uuid;
  previous_disposition text;
  evidence text;
  audit_id bigint;
  actor text;
BEGIN
  IF NEW.status<>'dead' OR OLD.status='dead' THEN RETURN NEW; END IF;
  SELECT id,disposition INTO letter_id,previous_disposition
  FROM outbox_dead_letters
  WHERE outbox_id=NEW.id AND resolved_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  evidence := encode(digest(convert_to(concat_ws('|',
    'outbox_reopened_after_retry_v1',letter_id::text,NEW.id::text,
    NEW.attempts::text,COALESCE(NEW.last_error,''),
    COALESCE(NEW.dead_at::text,'')
  ),'UTF8'),'sha256'),'hex');
  UPDATE outbox_dead_letters SET
    reason=COALESCE(NEW.last_error,reason),payload=NEW.payload,attempts=NEW.attempts,
    resolved_at=NULL,disposition='unclassified',disposition_at=NULL,
    resolution_rule=NULL,evidence_sha256=NULL,
    reopen_count=reopen_count+1,last_reopened_at=now()
  WHERE id=letter_id AND resolved_at IS NOT NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  actor := COALESCE(NULLIF(btrim(NEW.claimed_by),''),'outbox-worker');
  INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
  VALUES(
    NEW.tenant_id,actor,'dlq.reopen','info',
    jsonb_build_object(
      'schema_version',1,'rule','outbox_reopened_after_retry_v1',
      'actor_sha256',encode(digest(convert_to(NEW.tenant_id || chr(31) || actor,'UTF8'),'sha256'),'hex'),
      'counts',jsonb_build_object('transitions',1,'reopened',1),
      'evidence_sha256',evidence
    )
  ) RETURNING id INTO audit_id;
  INSERT INTO dlq_reconciliation_transitions(
    target,dead_letter_id,rule,actor_tenant,actor_alias,evidence_sha256,
    from_disposition,to_disposition,resolved,audit_event_id
  ) VALUES(
    'outbox',letter_id,'outbox_reopened_after_retry_v1',NEW.tenant_id,actor,evidence,
    previous_disposition,'unclassified',false,audit_id
  );
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cauce_reopen_outbox_dead_letter_030 ON adapter_outbox;
CREATE TRIGGER cauce_reopen_outbox_dead_letter_030
AFTER UPDATE OF status ON adapter_outbox
FOR EACH ROW EXECUTE FUNCTION cauce_reopen_outbox_dead_letter_030();

-- Private operator inspection bridges the public safe-list selector to a manual replay request.
-- It exposes only a content digest plus non-identifying state/generation facts.  In particular,
-- effect_id is derived from outbox_id in the Telegram bridge, so neither identifier may cross this
-- boundary.  Manual replay resolves the unique effect DB-side and revalidates all evidence.
CREATE OR REPLACE FUNCTION cauce_inspect_telegram_replay_030(
  p_dead_letter_id uuid,
  p_evidence_sha256 text,
  p_actor_tenant text,
  p_actor_alias text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  target_tenant text;
  causal_outbox_id uuid;
  effects jsonb;
BEGIN
  IF p_dead_letter_id IS NULL OR p_evidence_sha256 IS NULL
     OR p_evidence_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Telegram replay inspection requires exact DLQ id and evidence SHA-256';
  END IF;
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  PERFORM pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));
  SELECT letter.tenant_id,letter.outbox_id INTO target_tenant,causal_outbox_id
  FROM outbox_dead_letters letter
  WHERE letter.id=p_dead_letter_id AND letter.evidence_sha256=p_evidence_sha256
    AND letter.resolved_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Telegram replay inspection incident evidence changed'; END IF;
  IF NOT cauce_dlq_lock_control_tenant_030(
    p_actor_tenant,p_actor_alias,target_tenant
  ) THEN
    RAISE EXCEPTION 'Telegram replay inspection target is outside actor control scope';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('telegram-effect:' || causal_outbox_id::text,0)
  );
  PERFORM 1
  FROM outbox_dead_letters letter
  JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
  WHERE letter.id=p_dead_letter_id AND letter.evidence_sha256=p_evidence_sha256
    AND letter.resolved_at IS NULL AND outbox.id=causal_outbox_id
    AND letter.tenant_id=outbox.tenant_id AND letter.adapter=outbox.adapter
    AND letter.kind=outbox.kind AND outbox.status='dead'
    AND outbox.adapter='telegram' AND outbox.kind='origin_relay'
  FOR SHARE OF letter,outbox;
  IF NOT FOUND THEN RAISE EXCEPTION 'Telegram replay inspection was fenced by current incident state'; END IF;

  WITH effect_set AS MATERIALIZED (
    SELECT effect.*,
           bool_and(effect.state IN ('prepared','sent')) OVER () AS only_prepared_or_sent
    FROM telegram_egress_effects effect
    WHERE effect.outbox_id=causal_outbox_id AND effect.tenant_id=target_tenant
  ), eligible_effects AS MATERIALIZED (
    SELECT effect_set.*
    FROM effect_set
    WHERE provider_message_id IS NULL AND sent_at IS NULL
      AND (
        state IN ('ambiguous','dead')
        OR (state='prepared' AND only_prepared_or_sent)
      )
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'chunkIndex',chunk_index,'effectSha256',payload_hash,'state',state,
    'replayCount',replay_count,'duplicateRisk',state<>'prepared'
  ) ORDER BY payload_hash,replay_count,state,effect_id),'[]'::jsonb) INTO effects
  FROM eligible_effects;
  RETURN jsonb_build_object(
    'schemaVersion',1,'suite','cauce-v3-telegram-replay-inspect','phase','inspect',
    'id',p_dead_letter_id,'evidenceSha256',p_evidence_sha256,
    'items',effects,'total',jsonb_array_length(effects)
  );
END
$$;

DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,text,text,text,text,boolean);
DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,text,text,text,text,boolean,uuid);
DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,text,text,text,text,boolean,uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,text,text,text,boolean,uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,integer,text,text,text,boolean,uuid,uuid,text,integer);
CREATE OR REPLACE FUNCTION cauce_manual_replay_telegram_030(
  p_payload_sha256 text,
  p_chunk_index integer,
  p_reason text,
  p_actor_tenant text,
  p_actor_alias text,
  p_duplicate_risk_acknowledged boolean,
  p_request_id uuid,
  p_dead_letter_id uuid,
  p_incident_evidence_sha256 text,
  p_expected_replay_count integer
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  effect_row telegram_egress_effects%ROWTYPE;
  outbox_row adapter_outbox%ROWTYPE;
  letter_row outbox_dead_letters%ROWTYPE;
  existing_replay telegram_manual_replays%ROWTYPE;
  causal_key text;
  causal_outbox_id uuid;
  replay_sequence integer;
  safe_prepared_retry boolean;
  transition_rule text;
  replay_diagnostic text;
  actor_sha256 text;
  evidence text;
  audit_id bigint;
  candidate_count integer;
  prepared_set_safe boolean;
BEGIN
  IF p_request_id IS NULL OR p_dead_letter_id IS NULL OR p_payload_sha256 IS NULL
     OR p_payload_sha256 !~ '^[a-f0-9]{64}$'
     OR p_chunk_index IS NULL OR p_chunk_index<0
     OR p_incident_evidence_sha256 IS NULL
     OR p_incident_evidence_sha256 !~ '^[a-f0-9]{64}$'
     OR p_expected_replay_count IS NULL OR p_expected_replay_count<0 THEN
    RAISE EXCEPTION 'Telegram manual replay requires exact incident/effect evidence and replay count';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000
     OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Telegram manual replay requires a bounded non-empty reason';
  END IF;
  IF NOT COALESCE(p_duplicate_risk_acknowledged,false) THEN
    RAISE EXCEPTION 'Telegram manual replay requires explicit duplicate-risk acknowledgement';
  END IF;
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  PERFORM pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));

  -- A retry of the exact same operator request remains idempotent after the incident has been
  -- resolved and its evidence digest has advanced.  The durable ledger is internal and may keep
  -- effect/outbox ids; the caller never supplies or receives them.
  SELECT replay.* INTO existing_replay
  FROM telegram_manual_replays replay
  WHERE replay.request_id=p_request_id
  FOR UPDATE;
  IF FOUND THEN
    IF existing_replay.payload_sha256<>p_payload_sha256
       OR existing_replay.actor_tenant<>p_actor_tenant
       OR existing_replay.actor_alias<>p_actor_alias
       OR existing_replay.reason<>btrim(p_reason)
       OR existing_replay.dead_letter_id<>p_dead_letter_id
       OR existing_replay.expected_incident_evidence_sha256<>p_incident_evidence_sha256
       OR existing_replay.expected_replay_count<>p_expected_replay_count
       OR existing_replay.duplicate_risk_acknowledged<>p_duplicate_risk_acknowledged THEN
      RAISE EXCEPTION 'Telegram manual replay was already scheduled with a different decision';
    END IF;
    SELECT COALESCE(
      outbox.payload#>>'{correlation,root_message_id}',
      outbox.payload#>>'{correlation,message_id}'
    ),outbox.id INTO causal_key,causal_outbox_id
    FROM adapter_outbox outbox WHERE outbox.id=existing_replay.outbox_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Telegram manual replay history lost its causal outbox'; END IF;
    IF causal_key IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('telegram-origin-relay:' || causal_key,0));
    END IF;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('telegram-effect:' || causal_outbox_id::text,0)
    );
    SELECT effect.* INTO effect_row
    FROM telegram_egress_effects effect
    WHERE effect.effect_id=existing_replay.effect_id FOR SHARE;
    IF NOT FOUND OR effect_row.chunk_index<>p_chunk_index THEN
      RAISE EXCEPTION 'Telegram manual replay was already scheduled with a different decision';
    END IF;
    SELECT outbox.* INTO outbox_row
    FROM adapter_outbox outbox WHERE outbox.id=causal_outbox_id FOR SHARE;
    IF NOT cauce_dlq_lock_control_tenant_030(
      p_actor_tenant,p_actor_alias,outbox_row.tenant_id
    ) THEN
      RAISE EXCEPTION 'Telegram manual replay target is outside actor control scope';
    END IF;
    RETURN jsonb_build_object(
      'schemaVersion',1,'suite','cauce-v3-telegram-manual-replay','phase','scheduled',
      'appliedCount',0,'alreadyApplied',true,
      'replaySequence',existing_replay.replay_sequence,'effectSha256',p_payload_sha256,
      'evidenceSha256',existing_replay.evidence_sha256,
      'duplicateRisk',existing_replay.duplicate_risk,
      'warning',CASE WHEN existing_replay.duplicate_risk
        THEN 'Telegram may already have accepted this effect; operator accepted duplicate risk'
        ELSE 'Prepared effect was never begun; only durably unsent chunks were scheduled' END
    );
  END IF;

  SELECT COALESCE(
    outbox.payload#>>'{correlation,root_message_id}',
    outbox.payload#>>'{correlation,message_id}'
  ),outbox.id INTO causal_key,causal_outbox_id
  FROM outbox_dead_letters letter
  JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
  WHERE letter.id=p_dead_letter_id
    AND letter.evidence_sha256=p_incident_evidence_sha256
    AND letter.resolved_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Telegram manual replay incident evidence changed'; END IF;
  IF causal_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('telegram-origin-relay:' || causal_key,0));
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('telegram-effect:' || causal_outbox_id::text,0)
  );

  -- Effect writers take the same outbox-stable advisory before touching these rows. Lock the
  -- complete set before deciding uniqueness, otherwise a second matching chunk could appear
  -- between inspection and CAS.
  PERFORM 1 FROM telegram_egress_effects effect
  WHERE effect.outbox_id=causal_outbox_id
  ORDER BY effect.effect_id FOR UPDATE;
  SELECT outbox.* INTO outbox_row
  FROM adapter_outbox outbox WHERE outbox.id=causal_outbox_id FOR UPDATE;
  SELECT letter.* INTO letter_row
  FROM outbox_dead_letters letter WHERE letter.id=p_dead_letter_id FOR UPDATE;
  IF NOT cauce_dlq_lock_control_tenant_030(
    p_actor_tenant,p_actor_alias,outbox_row.tenant_id
  ) THEN
    RAISE EXCEPTION 'Telegram manual replay target is outside actor control scope';
  END IF;
  SELECT COALESCE(bool_and(effect.state IN ('prepared','sent')),false)
    INTO prepared_set_safe
  FROM telegram_egress_effects effect
  WHERE effect.outbox_id=causal_outbox_id;
  SELECT count(*) INTO candidate_count
  FROM telegram_egress_effects effect
  WHERE effect.outbox_id=causal_outbox_id
    AND effect.tenant_id=outbox_row.tenant_id
    AND effect.chunk_index=p_chunk_index
    AND effect.payload_hash=p_payload_sha256
    AND effect.replay_count=p_expected_replay_count
    AND effect.provider_message_id IS NULL AND effect.sent_at IS NULL
    AND (
      effect.state IN ('ambiguous','dead')
      OR (effect.state='prepared' AND prepared_set_safe)
    );
  IF candidate_count<>1 THEN
    RAISE EXCEPTION 'Telegram manual replay selector must match exactly one current effect';
  END IF;
  SELECT effect.* INTO effect_row
  FROM telegram_egress_effects effect
  WHERE effect.outbox_id=causal_outbox_id
    AND effect.tenant_id=outbox_row.tenant_id
    AND effect.chunk_index=p_chunk_index
    AND effect.payload_hash=p_payload_sha256
    AND effect.replay_count=p_expected_replay_count
    AND effect.provider_message_id IS NULL AND effect.sent_at IS NULL
    AND (
      effect.state IN ('ambiguous','dead')
      OR (effect.state='prepared' AND prepared_set_safe)
    );
  safe_prepared_retry := effect_row.state='prepared' AND prepared_set_safe;
  IF letter_row.id IS DISTINCT FROM p_dead_letter_id
     OR letter_row.evidence_sha256 IS DISTINCT FROM p_incident_evidence_sha256
     OR letter_row.resolved_at IS NOT NULL
     OR effect_row.replay_count<>p_expected_replay_count
     OR effect_row.state NOT IN ('prepared','ambiguous','dead')
     OR (effect_row.state='prepared' AND NOT COALESCE(safe_prepared_retry,false))
     OR outbox_row.status<>'dead' OR letter_row.id IS NULL
     OR effect_row.tenant_id<>outbox_row.tenant_id
     OR letter_row.tenant_id<>outbox_row.tenant_id
     OR letter_row.adapter<>outbox_row.adapter OR letter_row.kind<>outbox_row.kind
     OR outbox_row.adapter<>'telegram' OR outbox_row.kind<>'origin_relay' THEN
    RAISE EXCEPTION 'Telegram manual replay was fenced by current incident/effect evidence';
  END IF;
  IF effect_row.provider_message_id IS NOT NULL OR effect_row.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'Telegram manual replay refuses an effect with durable provider acceptance';
  END IF;
  IF outbox_row.payload->>'relay_kind'='ack' AND EXISTS (
    SELECT 1 FROM adapter_outbox final
    WHERE final.tenant_id=outbox_row.tenant_id
      AND final.adapter=outbox_row.adapter AND final.kind=outbox_row.kind
      AND final.id<>outbox_row.id
      AND final.payload->>'relay_kind' IS DISTINCT FROM 'ack'
      AND COALESCE(
        final.payload#>>'{correlation,root_message_id}',
        final.payload#>>'{correlation,message_id}'
      )=causal_key
      AND (
        final.attempts>0 OR final.status IN ('sent','dead')
        OR (final.status='processing' AND final.claimed_at IS NOT NULL)
      )
  ) THEN
    RAISE EXCEPTION 'Telegram acceptance ACK replay is forbidden after its final relay was claimed or terminal';
  END IF;

  replay_sequence := p_expected_replay_count + 1;
  transition_rule := CASE WHEN safe_prepared_retry
    THEN 'telegram_prepared_retry_v1' ELSE 'telegram_manual_replay_v1' END;
  replay_diagnostic := CASE WHEN safe_prepared_retry
    THEN 'Prepared Telegram effect was never begun; retry authorized for unsent chunks'
    ELSE 'Manual replay authorized; duplicate delivery remains possible' END;
  actor_sha256 := encode(digest(convert_to(p_actor_tenant || chr(31) || p_actor_alias,'UTF8'),'sha256'),'hex');
  evidence := encode(digest(convert_to(concat_ws('|',
    transition_rule,effect_row.effect_id,effect_row.outbox_id::text,
    p_chunk_index::text,p_payload_sha256,p_request_id::text,p_incident_evidence_sha256,
    p_expected_replay_count::text,replay_sequence::text,actor_sha256,
    encode(digest(convert_to(btrim(p_reason),'UTF8'),'sha256'),'hex')
  ),'UTF8'),'sha256'),'hex');

  UPDATE telegram_egress_effects SET
    state='prepared',sending_at=NULL,provider_message_id=NULL,
    diagnostic=replay_diagnostic,
    diagnosed_at=now(),replay_count=replay_sequence,replayed_at=now()
  WHERE effect_id=effect_row.effect_id AND payload_hash=p_payload_sha256
    AND replay_count=p_expected_replay_count
    AND (
      (safe_prepared_retry AND state='prepared')
      OR (NOT safe_prepared_retry AND state IN ('ambiguous','dead'))
    );
  IF NOT FOUND THEN RAISE EXCEPTION 'Telegram manual replay effect CAS was fenced'; END IF;

  UPDATE adapter_outbox SET
    status='failed',available_at=now(),claimed_by=NULL,claim_token=NULL,
    claim_expires_at=NULL,dead_at=NULL,
    last_error=replay_diagnostic,
    max_attempts=GREATEST(max_attempts,attempts+1)
  WHERE id=effect_row.outbox_id AND status='dead';
  IF NOT FOUND THEN RAISE EXCEPTION 'Telegram manual replay outbox CAS was fenced'; END IF;

  UPDATE outbox_dead_letters SET
    resolved_at=now(),disposition='safe_retry',disposition_at=now(),
    resolution_rule=transition_rule,evidence_sha256=evidence
  WHERE id=letter_row.id AND resolved_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Telegram manual replay DLQ CAS was fenced'; END IF;

  INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
  VALUES(
    outbox_row.tenant_id,p_actor_alias,'telegram.manual_replay','allow',
    jsonb_build_object(
      'schema_version',1,'rule',transition_rule,'actor_sha256',actor_sha256,
      'counts',jsonb_build_object('transitions',1,'scheduled',1),
      'effect_sha256',p_payload_sha256,
      'reason_sha256',encode(digest(convert_to(btrim(p_reason),'UTF8'),'sha256'),'hex'),
      'evidence_sha256',evidence,'duplicate_risk_acknowledged',true,
      'duplicate_risk',NOT safe_prepared_retry
    )
  ) RETURNING id INTO audit_id;
  INSERT INTO telegram_manual_replays(
    request_id,effect_id,outbox_id,dead_letter_id,expected_incident_evidence_sha256,
    expected_replay_count,replay_sequence,payload_sha256,actor_tenant,actor_alias,reason,
    duplicate_risk,duplicate_risk_acknowledged,evidence_sha256,audit_event_id
  ) VALUES(
    p_request_id,effect_row.effect_id,effect_row.outbox_id,p_dead_letter_id,p_incident_evidence_sha256,
    p_expected_replay_count,replay_sequence,p_payload_sha256,
    p_actor_tenant,p_actor_alias,btrim(p_reason),NOT safe_prepared_retry,true,evidence,audit_id
  );
  INSERT INTO dlq_reconciliation_transitions(
    target,dead_letter_id,rule,actor_tenant,actor_alias,evidence_sha256,
    from_disposition,to_disposition,resolved,audit_event_id
  ) VALUES(
    'outbox',letter_row.id,transition_rule,p_actor_tenant,p_actor_alias,evidence,
    letter_row.disposition,'safe_retry',true,audit_id
  );

  RETURN jsonb_build_object(
    'schemaVersion',1,'suite','cauce-v3-telegram-manual-replay','phase','scheduled',
    'appliedCount',1,'alreadyApplied',false,
    'replaySequence',replay_sequence,'effectSha256',p_payload_sha256,
    'evidenceSha256',evidence,'duplicateRisk',NOT safe_prepared_retry,
    'warning',CASE WHEN safe_prepared_retry
      THEN 'Prepared effect was never begun; only durably unsent chunks were scheduled'
      ELSE 'Telegram may already have accepted this effect; operator accepted duplicate risk' END
  );
END
$$;

CREATE OR REPLACE FUNCTION cauce_resolve_dlq_without_replay_030(
  p_target text,
  p_dead_letter_id uuid,
  p_evidence_sha256 text,
  p_reason text,
  p_actor_tenant text,
  p_actor_alias text,
  p_possible_duplicate_acknowledged boolean,
  p_possible_no_delivery_acknowledged boolean
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  target_tenant text;
  current_disposition text;
  current_evidence text;
  current_resolved_at timestamptz;
  actor_sha256 text;
  reason_sha256 text;
  audit_id bigint;
  changed integer;
  existing dlq_operator_resolutions%ROWTYPE;
BEGIN
  IF p_target NOT IN ('delivery','outbox') OR p_dead_letter_id IS NULL
     OR p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'DLQ no-replay resolution requires an exact target, id and evidence SHA-256';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000
     OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'DLQ no-replay resolution requires a bounded non-empty reason';
  END IF;
  IF NOT COALESCE(p_possible_no_delivery_acknowledged,false) THEN
    RAISE EXCEPTION 'DLQ no-replay resolution requires no-delivery acknowledgement';
  END IF;
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  PERFORM pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));
  actor_sha256 := encode(digest(convert_to(p_actor_tenant || chr(31) || p_actor_alias,'UTF8'),'sha256'),'hex');

  SELECT * INTO existing FROM dlq_operator_resolutions
  WHERE target=p_target AND dead_letter_id=p_dead_letter_id
    AND evidence_sha256=p_evidence_sha256 FOR UPDATE;
  IF FOUND THEN
    IF existing.actor_tenant<>p_actor_tenant OR existing.actor_alias<>p_actor_alias THEN
      RAISE EXCEPTION 'DLQ incident was already resolved by a different actor';
    END IF;
    IF existing.reason<>btrim(p_reason)
       OR existing.possible_duplicate_acknowledged<>COALESCE(p_possible_duplicate_acknowledged,false)
       OR existing.possible_no_delivery_acknowledged<>COALESCE(p_possible_no_delivery_acknowledged,false) THEN
      RAISE EXCEPTION 'DLQ incident was already resolved with a different operator decision';
    END IF;
    RETURN jsonb_build_object(
      'schemaVersion',1,'suite','cauce-v3-dlq-no-replay-resolution','phase','resolved',
      'appliedCount',0,'alreadyApplied',true,'evidenceSha256',p_evidence_sha256,
      'reasonSha256',encode(digest(convert_to(existing.reason,'UTF8'),'sha256'),'hex'),
      'possibleDuplicateAcknowledged',existing.possible_duplicate_acknowledged,
      'possibleNoDeliveryAcknowledged',existing.possible_no_delivery_acknowledged
    );
  END IF;

  IF p_target='outbox' THEN
    SELECT letter.tenant_id,letter.disposition,letter.evidence_sha256,letter.resolved_at
    INTO target_tenant,current_disposition,current_evidence,current_resolved_at
    FROM outbox_dead_letters letter WHERE letter.id=p_dead_letter_id FOR UPDATE;
  ELSE
    SELECT letter.tenant_id,letter.disposition,letter.evidence_sha256,letter.resolved_at
    INTO target_tenant,current_disposition,current_evidence,current_resolved_at
    FROM dead_letters letter WHERE letter.id=p_dead_letter_id FOR UPDATE;
  END IF;
  IF NOT FOUND OR current_resolved_at IS NOT NULL
     OR current_disposition NOT IN ('ambiguous','safe_retry','missing_final','auth')
     OR current_evidence IS DISTINCT FROM p_evidence_sha256 THEN
    RAISE EXCEPTION 'DLQ no-replay resolution was fenced by current incident state or evidence';
  END IF;
  IF current_disposition IN ('ambiguous','missing_final')
     AND NOT COALESCE(p_possible_duplicate_acknowledged,false) THEN
    RAISE EXCEPTION 'DLQ no-replay resolution requires possible-duplicate acknowledgement for uncertain effects';
  END IF;
  IF NOT cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,target_tenant) THEN
    RAISE EXCEPTION 'DLQ no-replay target is outside actor control scope';
  END IF;

  reason_sha256 := encode(digest(convert_to(btrim(p_reason),'UTF8'),'sha256'),'hex');
  IF p_target='outbox' THEN
    UPDATE outbox_dead_letters SET
      resolved_at=now(),resolution_rule='operator_no_replay_v1',disposition_at=now()
    WHERE id=p_dead_letter_id AND resolved_at IS NULL
      AND disposition=current_disposition
      AND evidence_sha256=p_evidence_sha256;
  ELSE
    UPDATE dead_letters SET
      resolved_at=now(),resolution_rule='operator_no_replay_v1',disposition_at=now()
    WHERE id=p_dead_letter_id AND resolved_at IS NULL
      AND disposition=current_disposition
      AND evidence_sha256=p_evidence_sha256;
  END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'DLQ no-replay resolution CAS was fenced'; END IF;

  INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
  VALUES(
    target_tenant,p_actor_alias,'dlq.resolve_without_replay','allow',
    jsonb_build_object(
      'schema_version',1,'rule','operator_no_replay_v1','actor_sha256',actor_sha256,
      'counts',jsonb_build_object('transitions',1,'resolved',1,'replayed',0),
      'evidence_sha256',p_evidence_sha256,'reason_sha256',reason_sha256,
      'possible_duplicate_acknowledged',COALESCE(p_possible_duplicate_acknowledged,false),
      'possible_no_delivery_acknowledged',true
    )
  ) RETURNING id INTO audit_id;
  INSERT INTO dlq_operator_resolutions(
    target,dead_letter_id,evidence_sha256,actor_tenant,actor_alias,reason,
    possible_duplicate_acknowledged,possible_no_delivery_acknowledged,audit_event_id
  ) VALUES(
    p_target,p_dead_letter_id,p_evidence_sha256,p_actor_tenant,p_actor_alias,btrim(p_reason),
    COALESCE(p_possible_duplicate_acknowledged,false),true,audit_id
  );
  INSERT INTO dlq_reconciliation_transitions(
    target,dead_letter_id,rule,actor_tenant,actor_alias,evidence_sha256,
    from_disposition,to_disposition,resolved,audit_event_id
  ) VALUES(
    p_target,p_dead_letter_id,'operator_no_replay_v1',p_actor_tenant,p_actor_alias,
    p_evidence_sha256,current_disposition,current_disposition,true,audit_id
  );
  RETURN jsonb_build_object(
    'schemaVersion',1,'suite','cauce-v3-dlq-no-replay-resolution','phase','resolved',
    'appliedCount',1,'alreadyApplied',false,'evidenceSha256',p_evidence_sha256,
    'reasonSha256',reason_sha256,
    'possibleDuplicateAcknowledged',COALESCE(p_possible_duplicate_acknowledged,false),
    'possibleNoDeliveryAcknowledged',true
  );
END
$$;

-- Safe per-incident selector for gateway/console.  Scope is enforced in PostgreSQL with the same
-- control edge required by mutations.  It exposes internal DLQ ids/evidence needed for an exact
-- CAS, but never payload, reason, error, origin, message/delivery/outbox/provider ids or bodies.
CREATE OR REPLACE FUNCTION cauce_list_dlq_030(
  p_actor_tenant text,
  p_actor_alias text,
  p_limit integer,
  p_cursor text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  items jsonb;
  total bigint;
  has_more boolean;
  next_cursor text;
  cursor_payload jsonb;
  cursor_created_at timestamptz;
  cursor_target text;
  cursor_id uuid;
  cursor_scope_sha256 text;
  expected_scope_sha256 text;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN
    RAISE EXCEPTION 'DLQ list limit must be between 1 and 500';
  END IF;
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  expected_scope_sha256 := encode(digest(
    convert_to(p_actor_tenant || chr(31) || p_actor_alias,'UTF8'),'sha256'
  ),'hex');
  IF p_cursor IS NOT NULL THEN
    IF length(p_cursor)>1024 OR length(p_cursor)<2 OR length(p_cursor)%2<>0
       OR p_cursor !~ '^[a-f0-9]+$' THEN
      RAISE EXCEPTION 'DLQ list cursor is invalid' USING ERRCODE='22023';
    END IF;
    BEGIN
      cursor_payload := convert_from(decode(p_cursor,'hex'),'UTF8')::jsonb;
      IF jsonb_typeof(cursor_payload)<>'object' THEN
        RAISE EXCEPTION 'invalid cursor shape';
      END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(cursor_payload))<>5
         OR NOT cursor_payload ?& ARRAY['v','createdAt','target','id','scopeSha256'] THEN
        RAISE EXCEPTION 'invalid cursor fields';
      END IF;
      cursor_created_at := (cursor_payload->>'createdAt')::timestamptz;
      cursor_target := cursor_payload->>'target';
      cursor_id := (cursor_payload->>'id')::uuid;
      cursor_scope_sha256 := cursor_payload->>'scopeSha256';
      IF cursor_payload->>'v'<>'1' OR NOT isfinite(cursor_created_at)
         OR cursor_target NOT IN ('outbox','delivery')
         OR cursor_payload->>'createdAt'<>to_char(
           cursor_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         )
         OR cursor_payload->>'id'<>cursor_id::text
         OR cursor_scope_sha256 IS DISTINCT FROM expected_scope_sha256 THEN
        RAISE EXCEPTION 'invalid cursor values';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'DLQ list cursor is invalid' USING ERRCODE='22023';
    END;
  END IF;
  WITH visible AS (
    SELECT 'outbox'::text AS target,letter.id,letter.tenant_id,
           letter.kind::text AS kind,letter.adapter::text AS adapter,
           letter.disposition,letter.resolved_at IS NULL AS open,
           letter.resolved_at IS NULL
             AND letter.disposition IN ('ambiguous','safe_retry','missing_final','auth') AS actionable,
           letter.evidence_sha256,letter.attempts,letter.resolution_rule,
           letter.created_at,letter.disposition_at,letter.resolved_at,
           letter.reopen_count,letter.last_reopened_at
    FROM outbox_dead_letters letter
    WHERE cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
    UNION ALL
    SELECT 'delivery'::text,letter.id,letter.tenant_id,
           CASE WHEN letter.delivery_id IS NOT NULL THEN 'delivery' ELSE 'job' END::text,
           NULL::text,letter.disposition,letter.resolved_at IS NULL,
           letter.resolved_at IS NULL
             AND letter.disposition IN ('ambiguous','safe_retry','missing_final','auth'),
           letter.evidence_sha256,letter.attempts,letter.resolution_rule,
           letter.created_at,letter.disposition_at,letter.resolved_at,
           0,NULL::timestamptz
    FROM dead_letters letter
    WHERE cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
  ), counted AS (
    SELECT count(*) AS count FROM visible
  ), filtered AS (
    SELECT * FROM visible
    WHERE cursor_created_at IS NULL
       OR (created_at,target,id)<(cursor_created_at,cursor_target,cursor_id)
  ), page AS (
    SELECT * FROM filtered
    ORDER BY created_at DESC,target DESC,id DESC
    LIMIT p_limit+1
  ), selected AS (
    SELECT * FROM page
    ORDER BY created_at DESC,target DESC,id DESC
    LIMIT p_limit
  ), page_meta AS (
    SELECT count(*)>p_limit AS has_more FROM page
  ), last_selected AS (
    SELECT * FROM selected
    ORDER BY created_at ASC,target ASC,id ASC
    LIMIT 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'target',selected.target,'id',selected.id,'tenantId',selected.tenant_id,
           'kind',selected.kind,
           'adapter',selected.adapter,'disposition',selected.disposition,
           'open',selected.open,'actionable',selected.actionable,
           'evidenceSha256',selected.evidence_sha256,
           'attempts',selected.attempts,'resolutionRule',selected.resolution_rule,
           'createdAt',selected.created_at,'dispositionAt',selected.disposition_at,
           'resolvedAt',selected.resolved_at,'reopenCount',selected.reopen_count,
           'lastReopenedAt',selected.last_reopened_at
         ) ORDER BY selected.created_at DESC,selected.target DESC,selected.id DESC)
         FILTER (WHERE selected.id IS NOT NULL),'[]'::jsonb),
         counted.count,page_meta.has_more,
         CASE WHEN page_meta.has_more THEN encode(convert_to(jsonb_build_object(
           'v',1,
           'createdAt',to_char(
             last_selected.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ),
           'target',last_selected.target,
           'id',last_selected.id,
           'scopeSha256',expected_scope_sha256
         )::text,'UTF8'),'hex') ELSE NULL END
  INTO items,total,has_more,next_cursor
  FROM counted CROSS JOIN page_meta
  LEFT JOIN selected ON true
  LEFT JOIN last_selected ON true
  GROUP BY counted.count,page_meta.has_more,last_selected.created_at,
           last_selected.target,last_selected.id;
  RETURN jsonb_build_object(
    'schemaVersion',1,'items',items,'total',COALESCE(total,0),
    'truncated',COALESCE(has_more,false),'nextCursor',next_cursor
  );
END
$$;

-- Compatibility entrypoint for pre-030 callers.  New gateway/console callers pass the opaque
-- cursor to the four-argument overload; the first page remains source compatible.
CREATE OR REPLACE FUNCTION cauce_list_dlq_030(
  p_actor_tenant text,
  p_actor_alias text,
  p_limit integer DEFAULT 200
) RETURNS jsonb
LANGUAGE sql
AS $$
SELECT cauce_list_dlq_030(p_actor_tenant,p_actor_alias,p_limit,NULL)
$$;

-- Runtime-only repair of final-attempt crashes.  This is deliberately narrower than the operator
-- plan: it can recover exact sent proof and classify stranded sending effects, never replay them.
CREATE OR REPLACE FUNCTION cauce_reconcile_telegram_terminal_030(p_actor_alias text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  candidate record;
  causal record;
  effect_outbox record;
  audit_id bigint;
  changed integer;
  recovered integer := 0;
  proven_sent_at timestamptz;
  actor_sha256 text;
  causal_tenant text;
BEGIN
  IF p_actor_alias IS NULL OR btrim(p_actor_alias)='' THEN
    RAISE EXCEPTION 'Telegram terminal reconciliation requires an actor';
  END IF;
  actor_sha256 := encode(digest(convert_to('system' || chr(31) || p_actor_alias,'UTF8'),'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));
  FOR causal IN
    SELECT DISTINCT causal_key FROM cauce_dlq_candidates_030()
    WHERE causal_key IS NOT NULL ORDER BY causal_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('telegram-origin-relay:' || causal.causal_key,0));
  END LOOP;
  FOR effect_outbox IN
    SELECT DISTINCT outbox.id
    FROM outbox_dead_letters letter
    JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
    WHERE letter.resolved_at IS NULL
      AND outbox.adapter='telegram' AND outbox.kind='origin_relay'
    ORDER BY outbox.id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('telegram-effect:' || effect_outbox.id::text,0)
    );
  END LOOP;
  PERFORM 1 FROM outbox_dead_letters letter
  JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
  WHERE letter.resolved_at IS NULL AND outbox.adapter='telegram' AND outbox.kind='origin_relay'
  ORDER BY letter.id FOR UPDATE OF letter,outbox;
  PERFORM 1 FROM telegram_egress_effects effect
  JOIN adapter_outbox outbox ON outbox.id=effect.outbox_id
  WHERE outbox.adapter='telegram' AND outbox.kind='origin_relay' AND outbox.status='dead'
  ORDER BY effect.effect_id FOR UPDATE OF effect;

  FOR candidate IN SELECT * FROM cauce_dlq_candidates_030()
    WHERE rule='telegram_exact_sent_v1' ORDER BY dead_letter_id
  LOOP
    SELECT max(effect.sent_at) INTO proven_sent_at
    FROM telegram_egress_effects effect
    JOIN outbox_dead_letters letter ON letter.outbox_id=effect.outbox_id
    WHERE letter.id=candidate.dead_letter_id;
    UPDATE adapter_outbox outbox SET
      status='sent',sent_at=proven_sent_at,dead_at=NULL,claimed_by=NULL,claim_token=NULL,
      claim_expires_at=NULL,last_error=NULL
    FROM outbox_dead_letters letter
    WHERE letter.id=candidate.dead_letter_id AND letter.outbox_id=outbox.id
      AND letter.resolved_at IS NULL AND outbox.status='dead';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed=1 THEN
      UPDATE outbox_dead_letters SET
        resolved_at=now(),resolution_rule=candidate.rule,
        evidence_sha256=candidate.evidence_sha256,disposition_at=now()
      WHERE id=candidate.dead_letter_id AND resolved_at IS NULL;
      SELECT outbox.tenant_id INTO STRICT causal_tenant
      FROM adapter_outbox outbox JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
      WHERE letter.id=candidate.dead_letter_id;
      INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
      VALUES(
        causal_tenant,p_actor_alias,'dlq.reconcile','info',
        jsonb_build_object(
          'schema_version',1,'rule',candidate.rule,'actor_sha256',actor_sha256,
          'counts',jsonb_build_object('transitions',1,'resolved',1,'recovered_sent',1),
          'evidence_sha256',candidate.evidence_sha256
        )
      ) RETURNING id INTO audit_id;
      INSERT INTO dlq_reconciliation_transitions(
        target,dead_letter_id,rule,actor_tenant,actor_alias,evidence_sha256,
        from_disposition,to_disposition,resolved,audit_event_id
      )
      SELECT 'outbox',candidate.dead_letter_id,candidate.rule,causal_tenant,p_actor_alias,
             candidate.evidence_sha256,candidate.from_disposition,candidate.to_disposition,true,audit_id
      FROM adapter_outbox outbox JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
      WHERE letter.id=candidate.dead_letter_id;
      recovered := recovered + 1;
    END IF;
  END LOOP;

  -- `sending` after the outbox became dead is epistemically ambiguous.  Diagnose the effect and
  -- its incident together; there is no automatic replay and no inference from error text or age.
  FOR candidate IN
    SELECT letter.id AS dead_letter_id,outbox.tenant_id,
           encode(digest(convert_to(concat_ws('|',
             'telegram_effect_ambiguous_v1',letter.id::text,outbox.id::text,
             encode(digest(convert_to(string_agg(effect.effect_id || ':' || effect.payload_hash,
               '|' ORDER BY effect.effect_id),'UTF8'),'sha256'),'hex')
           ),'UTF8'),'sha256'),'hex') AS evidence_sha256,
           letter.disposition AS from_disposition
    FROM outbox_dead_letters letter
    JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
    JOIN telegram_egress_effects effect ON effect.outbox_id=outbox.id
    WHERE letter.resolved_at IS NULL AND letter.disposition='unclassified'
      AND letter.disposition_at IS NULL
      AND outbox.adapter='telegram' AND outbox.kind='origin_relay' AND outbox.status='dead'
      AND effect.state='sending'
    GROUP BY letter.id,outbox.id,outbox.tenant_id,letter.disposition
    ORDER BY letter.id
  LOOP
    UPDATE telegram_egress_effects effect SET
      state='ambiguous',
      diagnostic='Interrupted while a Telegram request may have been in flight; automatic replay is disabled',
      diagnosed_at=now()
    FROM outbox_dead_letters letter
    WHERE letter.id=candidate.dead_letter_id AND effect.outbox_id=letter.outbox_id
      AND effect.state='sending';
    UPDATE adapter_outbox outbox SET
      last_error='Interrupted while a Telegram request may have been in flight; automatic replay is disabled'
    FROM outbox_dead_letters letter
    WHERE letter.id=candidate.dead_letter_id AND letter.outbox_id=outbox.id
      AND outbox.status='dead';
    UPDATE outbox_dead_letters SET
      reason='Interrupted while a Telegram request may have been in flight; automatic replay is disabled',
      disposition='ambiguous',disposition_at=now(),evidence_sha256=candidate.evidence_sha256
    WHERE id=candidate.dead_letter_id AND resolved_at IS NULL
      AND disposition='unclassified' AND disposition_at IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed=1 THEN
      INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
      VALUES(
        candidate.tenant_id,p_actor_alias,'dlq.reconcile','info',
        jsonb_build_object(
          'schema_version',1,'rule','telegram_effect_ambiguous_v1','actor_sha256',actor_sha256,
          'counts',jsonb_build_object('transitions',1,'dispositions',1),
          'evidence_sha256',candidate.evidence_sha256
        )
      ) RETURNING id INTO audit_id;
      INSERT INTO dlq_reconciliation_transitions(
        target,dead_letter_id,rule,actor_tenant,actor_alias,evidence_sha256,
        from_disposition,to_disposition,resolved,audit_event_id
      ) VALUES(
        'outbox',candidate.dead_letter_id,'telegram_effect_ambiguous_v1',candidate.tenant_id,
        p_actor_alias,candidate.evidence_sha256,candidate.from_disposition,'ambiguous',false,audit_id
      );
    END IF;
  END LOOP;
  RETURN recovered;
END
$$;
