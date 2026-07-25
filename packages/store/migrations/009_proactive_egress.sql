-- Proactive egress: an agent may initiate contact instead of only answering an
-- inbound Telegram update. Authorization is the whole point of this migration.
--
-- Three durable structures, all default-deny:
--   egress_destinations  the allowlist. Zero rows after this migration, so no
--                        alias can notify anything until an operator creates a
--                        destination through a versioned config revision.
--   egress_contacts      the inbound-contact ledger. "prior contact" means
--                        exactly "a durable authenticated inbound message from
--                        that conversation to that alias exists".
--   egress_notifications every attempt, allowed AND denied. It is simultaneously
--                        the idempotency anchor, the rate-limit source of truth
--                        and the audit trail.
--
-- adapter_outbox keeps its DDL untouched: kind stays ('wake','origin_relay') and
-- the proactive discriminator is payload->>'relay_kind'='notify'. That keeps
-- claimOutbox and the Telegram bridge's outboxEvent() working unchanged.

-- 1. Role gate. Default-deny for every role seeded by 003, so applying this
--    migration grants nothing to the twelve live agents.
--
--    NOTE ON GRANULARITY: role_policies is keyed by role, and all twelve live
--    agents share role='agent'. Turning allow_notify on for 'agent' enables the
--    coarse gate for all of them at once. It is NOT the per-alias key: no alias
--    can notify without a row in egress_destinations for its own (tenant,alias),
--    which is per-alias by construction. To keep the coarse gate narrow as well,
--    enable proactive egress by creating a dedicated role
--    (role_policy create {role:'agent_notify', allow_notify:true, ...}) and
--    moving the single alias to it (membership update {role:'agent_notify'}).
ALTER TABLE role_policies ADD COLUMN IF NOT EXISTS allow_notify boolean NOT NULL DEFAULT false;

-- 2. Inbound contact ledger, written inside the same transaction as every
--    authenticated Telegram ingress message.
CREATE TABLE IF NOT EXISTS egress_contacts (
  tenant_id text NOT NULL REFERENCES tenants(id),
  alias text NOT NULL,
  adapter text NOT NULL CHECK (length(adapter) BETWEEN 1 AND 64),
  conversation_id text NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 256),
  conversation_kind text NOT NULL CHECK (conversation_kind IN ('dm','group','unknown')),
  first_inbound_at timestamptz NOT NULL DEFAULT now(),
  last_inbound_at timestamptz NOT NULL DEFAULT now(),
  inbound_count bigint NOT NULL DEFAULT 1 CHECK (inbound_count > 0),
  last_session_hash text CHECK (last_session_hash IS NULL OR last_session_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, alias, adapter, conversation_id)
);
CREATE INDEX IF NOT EXISTS egress_contacts_recent_idx
  ON egress_contacts (tenant_id, alias, last_inbound_at DESC);

-- 3. The allowlist. CRUD exclusively through ConfigMutation 'egress_destination',
--    which lands in config_revisions with a full inverse operation.
CREATE TABLE IF NOT EXISTS egress_destinations (
  tenant_id text NOT NULL REFERENCES tenants(id),
  alias text NOT NULL,
  handle text NOT NULL CHECK (handle ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  adapter text NOT NULL DEFAULT 'telegram' CHECK (adapter IN ('telegram')),
  channel text NOT NULL DEFAULT 'telegram' CHECK (length(channel) BETWEEN 1 AND 128),
  conversation_id text NOT NULL CHECK (conversation_id ~ '^-?[1-9][0-9]{0,19}$'),
  conversation_kind text NOT NULL CHECK (conversation_kind IN ('dm','group')),
  display_label text CHECK (display_label IS NULL OR length(display_label) BETWEEN 1 AND 128),
  allow_kinds text[] NOT NULL,
  require_prior_contact boolean NOT NULL DEFAULT true,
  contact_ttl_days integer NOT NULL DEFAULT 30 CHECK (contact_ttl_days BETWEEN 1 AND 3650),
  min_interval_seconds integer NOT NULL DEFAULT 300 CHECK (min_interval_seconds BETWEEN 0 AND 86400),
  max_per_hour integer NOT NULL DEFAULT 2 CHECK (max_per_hour BETWEEN 0 AND 60),
  max_per_day integer NOT NULL DEFAULT 8 CHECK (max_per_day BETWEEN 0 AND 500),
  max_per_root integer NOT NULL DEFAULT 1 CHECK (max_per_root BETWEEN 0 AND 20),
  quiet_hours_start smallint CHECK (quiet_hours_start IS NULL OR quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end smallint CHECK (quiet_hours_end IS NULL OR quiet_hours_end BETWEEN 0 AND 23),
  quiet_hours_tz text NOT NULL DEFAULT 'UTC' CHECK (length(quiet_hours_tz) BETWEEN 1 AND 64),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alias, handle),
  UNIQUE (tenant_id, alias, adapter, conversation_id),
  -- array_length of an empty array is NULL and a CHECK evaluating to NULL passes,
  -- so the empty list must be coalesced away explicitly. There is no DEFAULT
  -- either: a destination has to name the kinds it accepts.
  CONSTRAINT egress_destinations_allow_kinds_check CHECK (
    coalesce(array_length(allow_kinds, 1), 0) BETWEEN 1 AND 4
    AND allow_kinds <@ ARRAY['task_complete','decision_request','digest','alert']::text[]
  ),
  -- Cold contact with a PERSON is structurally impossible, not a setting:
  -- only a group destination may waive the prior-contact requirement.
  CONSTRAINT egress_destinations_no_cold_dm_check CHECK (
    require_prior_contact OR conversation_kind = 'group'
  ),
  CONSTRAINT egress_destinations_quiet_hours_check CHECK (
    num_nonnulls(quiet_hours_start, quiet_hours_end) <> 1
  )
);
CREATE INDEX IF NOT EXISTS egress_destinations_alias_idx
  ON egress_destinations (tenant_id, alias) WHERE enabled;

-- 4. Topology backstop: a destination requires an enabled membership for its
--    (tenant, alias). No foreign key is possible because memberships is keyed by
--    (tenant_id, room_id, alias). Same shape as cauce_deliveries_hub_star_guard.
--    The trigger deliberately has no UPDATE OF column list: it also stamps
--    updated_at, which must move on every column change.
CREATE OR REPLACE FUNCTION cauce_egress_destination_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships membership
    JOIN tenants tenant ON tenant.id=membership.tenant_id
    WHERE membership.tenant_id=NEW.tenant_id AND membership.alias=NEW.alias
      AND membership.enabled AND tenant.enabled
  ) THEN
    RAISE EXCEPTION 'egress destination requires an enabled membership: %/%',
      NEW.tenant_id, NEW.alias
      USING ERRCODE='23514', CONSTRAINT='egress_destinations_membership';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS egress_destinations_membership_guard ON egress_destinations;
CREATE TRIGGER egress_destinations_membership_guard
BEFORE INSERT OR UPDATE ON egress_destinations
FOR EACH ROW EXECUTE FUNCTION cauce_egress_destination_guard();

-- 5. Durable record of every proactive egress attempt, allowed and denied.
--    created_at uses clock_timestamp() rather than now(): now() is the
--    transaction start timestamp, and a long ACK transaction would otherwise
--    stamp its notification minutes in the past and under-count the sliding
--    rate-limit windows.
CREATE TABLE IF NOT EXISTS egress_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  alias text NOT NULL,
  handle text NOT NULL CHECK (length(handle) BETWEEN 1 AND 64),
  adapter text NOT NULL,
  conversation_id text,
  kind text NOT NULL CHECK (kind IN ('task_complete','decision_request','digest','alert')),
  source text NOT NULL CHECK (source IN ('agent_output','http','job')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  decision text NOT NULL CHECK (decision IN ('allowed','denied')),
  denial_code text CHECK (denial_code IS NULL OR denial_code IN (
    'notify_permission_denied','unknown_destination','destination_disabled',
    'kind_not_allowed','cold_contact','rate_limited','root_quota_exhausted',
    'quiet_hours','invalid_output','body_too_large','ambiguous_execution'
  )),
  body_hash text NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  body_bytes integer NOT NULL CHECK (body_bytes >= 0),
  source_delivery_id uuid REFERENCES deliveries(id),
  source_attempt integer CHECK (source_attempt IS NULL OR source_attempt > 0),
  notify_index integer CHECK (notify_index IS NULL OR notify_index >= 0),
  source_message_id uuid,
  source_root_message_id uuid,
  produced_message_id uuid UNIQUE REFERENCES messages(id),
  produced_outbox_id uuid UNIQUE REFERENCES adapter_outbox(id),
  root_message_id uuid,
  request_id uuid NOT NULL,
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 256),
  correlation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(correlation)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, alias, idempotency_key),
  -- Not named *_decision_check: Postgres already auto-names the inline CHECK on
  -- the `decision` column exactly that, and the two would collide.
  CONSTRAINT egress_notifications_decision_shape_check CHECK (
    (decision='allowed' AND denial_code IS NULL
      AND conversation_id IS NOT NULL
      AND produced_message_id IS NOT NULL AND produced_outbox_id IS NOT NULL)
    OR
    (decision='denied' AND denial_code IS NOT NULL
      AND produced_message_id IS NULL AND produced_outbox_id IS NULL)
  ),
  CONSTRAINT egress_notifications_agent_source_check CHECK (
    source <> 'agent_output'
    OR (source_delivery_id IS NOT NULL AND source_attempt IS NOT NULL AND notify_index IS NOT NULL)
  )
);

-- Second, independent idempotency guarantee for the in-band path: re-ACKing the
-- same delivery attempt cannot create a second notification even if the derived
-- idempotency key were ever changed.
CREATE UNIQUE INDEX IF NOT EXISTS egress_notifications_agent_output_idx
  ON egress_notifications (source_delivery_id, source_attempt, notify_index)
  WHERE source='agent_output';

-- Sliding rate-limit windows (hour / day / min_interval).
CREATE INDEX IF NOT EXISTS egress_notifications_window_idx
  ON egress_notifications (tenant_id, alias, handle, created_at DESC)
  WHERE decision='allowed';

-- Per-chain quota. max_per_root counts allowed notifications that originated in
-- the same conversation chain, which is source_root_message_id; root_message_id
-- is the notification's OWN message id and is unique per row, so filtering on it
-- would make max_per_root unenforceable.
CREATE INDEX IF NOT EXISTS egress_notifications_source_root_idx
  ON egress_notifications (source_root_message_id, created_at)
  WHERE decision='allowed' AND source_root_message_id IS NOT NULL;

-- Denials are the only way an operator learns that a proactive egress was
-- refused; they must be cheap to list.
CREATE INDEX IF NOT EXISTS egress_notifications_denied_idx
  ON egress_notifications (tenant_id, alias, created_at DESC)
  WHERE decision='denied';

-- 6. No seeds. allow_notify=false on every role plus zero destinations equals a
--    total default-deny. Enabling one alias is two explicit, audited config
--    revisions:
--      1) role_policy create {role:'agent_notify', allow_route/read..., allow_notify:true}
--         plus membership update {role:'agent_notify'} for that single alias
--      2) egress_destination create {tenant_id, alias, handle, ...}
