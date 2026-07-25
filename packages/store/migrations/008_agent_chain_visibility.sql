-- Agent chain visibility: durable delegation topology, cycle cutting and live progress.
--
-- Every object here is additive. No column is NOT NULL without a non-volatile default,
-- so the ALTER below is a catalog-only operation and never rewrites the table.

-- The delegation path is server-owned state. It deliberately does NOT live in the
-- message body or in the correlation jsonb: both are writable by the publisher and by
-- the agent, so reading a cycle guard from there would let a caller censor legitimate
-- delegations. The column is written only by the store, from the parent materialization.
ALTER TABLE agent_output_materializations
  ADD COLUMN IF NOT EXISTS visited_path text[] NOT NULL DEFAULT '{}';

-- Widen the rejection domain with 'cycle_detected'. The old domain is a strict subset of
-- the new one, so every existing row already satisfies the new predicate; NOT VALID keeps
-- ADD CONSTRAINT from taking a full table scan under ACCESS EXCLUSIVE inside the single
-- transaction that applies every migration. New rows are checked from this point on.
-- A `VALIDATE CONSTRAINT` can be run out of band later; it cannot fail.
ALTER TABLE agent_output_materializations
  DROP CONSTRAINT IF EXISTS agent_output_materializations_rejection_code_check;
ALTER TABLE agent_output_materializations
  ADD CONSTRAINT agent_output_materializations_rejection_code_check CHECK (
    rejection_code IS NULL OR rejection_code IN (
      'invalid_output',
      'unroutable_alias',
      'ambiguous_alias',
      'hop_budget_exhausted',
      'cycle_detected'
    )
  ) NOT VALID;

-- Interim progress budget, one row per chain root.
-- root_message_id has NO foreign key on purpose: it is derived from a correlation value
-- that is validated for shape but never for existence, so a REFERENCES clause would turn
-- a forged correlation into a constraint violation that aborts the whole ACK transaction.
CREATE TABLE IF NOT EXISTS agent_chain_progress (
  root_message_id uuid PRIMARY KEY,
  emitted integer NOT NULL DEFAULT 0 CHECK (emitted >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_chain_progress_created_idx
  ON agent_chain_progress (created_at);

-- Versioned chain policy. Every flag is born disabled so that deploying this migration
-- changes no behaviour at all, and so that the emergency stop is an audited configuration
-- mutation instead of a code rollback.
CREATE TABLE IF NOT EXISTS agent_chain_policies (
  id text PRIMARY KEY CHECK (id = 'default'),
  progress_relay_enabled boolean NOT NULL DEFAULT false,
  progress_relay_max_events integer NOT NULL DEFAULT 12
    CHECK (progress_relay_max_events BETWEEN 1 AND 64),
  cycle_cut_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO agent_chain_policies(id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- The chain read-model resolves a whole trace: materializations already have
-- (trace_id, created_at), the origin relays of the same trace did not.
CREATE INDEX IF NOT EXISTS adapter_outbox_trace_idx
  ON adapter_outbox (trace_id, created_at);
