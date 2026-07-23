-- Durable state for channel bridges and the identity-free V2/V3 shadow router.
-- All leases are fenced; all externally visible effects have stable idempotency records.

CREATE TABLE IF NOT EXISTS channel_bridge_cursors (
  bot_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  alias text NOT NULL,
  next_update_id bigint NOT NULL DEFAULT 0 CHECK (next_update_id >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_bridge_leases (
  bot_id text PRIMARY KEY,
  owner_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  lease_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_bridge_leases_expiry_idx
  ON channel_bridge_leases(lease_until);

CREATE TABLE IF NOT EXISTS telegram_egress_effects (
  effect_id text PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES adapter_outbox(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  bridge_alias text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  state text NOT NULL CHECK (state IN ('prepared','sending','sent')),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sending_at timestamptz,
  sent_at timestamptz,
  UNIQUE(outbox_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS telegram_egress_effects_state_idx
  ON telegram_egress_effects(state, created_at);

CREATE TABLE IF NOT EXISTS shadow_router_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL CHECK (direction IN ('v2-to-v3','v3-to-v2')),
  source_event_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id),
  mode text NOT NULL CHECK (mode IN ('shadow','compare','cutover')),
  correlation jsonb NOT NULL CHECK (jsonb_typeof(correlation) = 'object'),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claim_token uuid,
  claim_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(direction, source_event_id)
);
CREATE INDEX IF NOT EXISTS shadow_router_inbox_claim_idx
  ON shadow_router_inbox(available_at, created_at)
  WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS shadow_router_inbox_expiry_idx
  ON shadow_router_inbox(claim_expires_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS shadow_router_mappings (
  direction text NOT NULL CHECK (direction IN ('v2-to-v3','v3-to-v2')),
  source_event_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id),
  mode text NOT NULL CHECK (mode IN ('shadow','compare','cutover')),
  target_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  correlation jsonb NOT NULL CHECK (jsonb_typeof(correlation) = 'object'),
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','shadowed','compared','delivered','blocked','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(direction, source_event_id),
  UNIQUE(target_event_id)
);
CREATE INDEX IF NOT EXISTS shadow_router_mappings_tenant_idx
  ON shadow_router_mappings(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shadow_compare_verdicts (
  id bigserial PRIMARY KEY,
  direction text NOT NULL,
  source_event_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id),
  verdict text NOT NULL CHECK (verdict IN ('match','mismatch','no_baseline')),
  baseline_hash text,
  candidate_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(direction, source_event_id),
  FOREIGN KEY(direction, source_event_id)
    REFERENCES shadow_router_mappings(direction, source_event_id)
);

CREATE TABLE IF NOT EXISTS shadow_human_reply_guards (
  tenant_id text NOT NULL REFERENCES tenants(id),
  correlation_key text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('v2-to-v3','v3-to-v2')),
  source_event_id text NOT NULL,
  target_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, correlation_key),
  FOREIGN KEY(direction, source_event_id)
    REFERENCES shadow_router_mappings(direction, source_event_id)
);
