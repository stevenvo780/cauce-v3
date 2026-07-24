-- Transactional agent-to-agent routing for StructuredOutput.messages.
-- Rejected outputs retain only hashes and bounded correlation metadata.

CREATE TABLE IF NOT EXISTS agent_output_materializations (
  source_delivery_id uuid NOT NULL REFERENCES deliveries(id),
  source_attempt integer NOT NULL CHECK (source_attempt > 0),
  output_index integer NOT NULL CHECK (output_index >= 0),
  source_message_id uuid NOT NULL REFERENCES messages(id),
  source_tenant text NOT NULL REFERENCES tenants(id),
  source_alias text NOT NULL,
  target_tenant text REFERENCES tenants(id),
  target_alias text,
  target_ref_hash text NOT NULL CHECK (length(target_ref_hash) = 64),
  body_hash text NOT NULL CHECK (length(body_hash) = 64),
  status text NOT NULL CHECK (status IN ('materialized','rejected')),
  rejection_code text CHECK (
    rejection_code IS NULL OR rejection_code IN (
      'invalid_output',
      'unroutable_alias',
      'ambiguous_alias',
      'hop_budget_exhausted'
    )
  ),
  produced_message_id uuid UNIQUE REFERENCES messages(id),
  produced_delivery_id uuid UNIQUE REFERENCES deliveries(id),
  request_id uuid NOT NULL,
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 256),
  hop_count integer NOT NULL CHECK (hop_count > 0),
  hop_budget integer NOT NULL CHECK (hop_budget > 0),
  correlation jsonb NOT NULL CHECK (jsonb_typeof(correlation) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_delivery_id, source_attempt, output_index),
  CHECK (
    (status='materialized' AND rejection_code IS NULL
      AND target_tenant IS NOT NULL AND target_alias IS NOT NULL
      AND produced_message_id IS NOT NULL AND produced_delivery_id IS NOT NULL)
    OR
    (status='rejected' AND rejection_code IS NOT NULL
      AND produced_message_id IS NULL AND produced_delivery_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS agent_output_materializations_trace_idx
  ON agent_output_materializations(trace_id, created_at);
CREATE INDEX IF NOT EXISTS agent_output_materializations_source_message_idx
  ON agent_output_materializations(source_message_id, output_index);
CREATE INDEX IF NOT EXISTS agent_output_materializations_produced_message_idx
  ON agent_output_materializations(produced_message_id)
  WHERE produced_message_id IS NOT NULL;
