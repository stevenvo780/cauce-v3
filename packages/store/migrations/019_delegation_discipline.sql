-- 019: Disciplina de delegación, límites de abanico/aristas y compuertas de interacción humana.

ALTER TABLE agent_output_materializations
  DROP CONSTRAINT IF EXISTS agent_output_materializations_rejection_code_check;
ALTER TABLE agent_output_materializations
  ADD CONSTRAINT agent_output_materializations_rejection_code_check CHECK (
    rejection_code IS NULL OR rejection_code IN (
      'invalid_output',
      'unroutable_alias',
      'ambiguous_alias',
      'hop_budget_exhausted',
      'cycle_detected',
      'fanout_exceeded',
      'edge_repeat_exceeded',
      'root_budget_exhausted',
      'chain_gated',
      'human_gate_opened'
    )
  ) NOT VALID;

-- 2. Combustible por raíz (columna delegations en agent_chain_progress).
ALTER TABLE agent_chain_progress
  ADD COLUMN IF NOT EXISTS delegations integer NOT NULL DEFAULT 0;
ALTER TABLE agent_chain_progress
  DROP CONSTRAINT IF EXISTS agent_chain_progress_delegations_check;
ALTER TABLE agent_chain_progress
  ADD CONSTRAINT agent_chain_progress_delegations_check CHECK (delegations >= 0) NOT VALID;

-- 3. Contador de aristas por raíz (agent_chain_edge_uses).
CREATE TABLE IF NOT EXISTS agent_chain_edge_uses (
  root_message_id uuid NOT NULL,
  source_node text NOT NULL CHECK (length(source_node) BETWEEN 3 AND 130),
  target_node text NOT NULL CHECK (length(target_node) BETWEEN 3 AND 130),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  first_used_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_message_id, source_node, target_node)
);

CREATE INDEX IF NOT EXISTS agent_chain_edge_uses_last_used_idx
  ON agent_chain_edge_uses (last_used_at);

-- 4. Compuerta humana: tabla con estado para solicitudes que requieren intervención humana.
CREATE TABLE IF NOT EXISTS agent_chain_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_message_id uuid NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id),
  asked_by_alias text NOT NULL,
  source_delivery_id uuid NOT NULL REFERENCES deliveries(id),
  source_attempt integer NOT NULL CHECK (source_attempt > 0),
  output_index integer NOT NULL CHECK (output_index >= 0),
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 256),
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 8192),
  -- Correlación completa de la rama suspendida.
  correlation jsonb NOT NULL CHECK (jsonb_typeof(correlation) = 'object'),
  -- Origen del turno que abrió la compuerta.
  origin jsonb,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'cancelled')),
  answer text CHECK (answer IS NULL OR length(answer) BETWEEN 1 AND 8192),
  answered_at timestamptz,
  answered_by text,
  resume_message_id uuid REFERENCES messages(id),
  resume_delivery_id uuid REFERENCES deliveries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_chain_gates_source_unique
    UNIQUE (source_delivery_id, source_attempt, output_index),
  CONSTRAINT agent_chain_gates_answer_shape CHECK (
    (status = 'open' AND answer IS NULL AND answered_at IS NULL)
    OR (status = 'answered' AND answer IS NOT NULL AND answered_at IS NOT NULL)
    OR (status = 'cancelled')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_chain_gates_open_root_idx
  ON agent_chain_gates (root_message_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS agent_chain_gates_open_idx
  ON agent_chain_gates (created_at DESC) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS agent_chain_gates_tenant_idx
  ON agent_chain_gates (tenant_id, created_at DESC);

ALTER TABLE agent_chain_policies
  ADD COLUMN IF NOT EXISTS delegation_caps_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE agent_chain_policies
  ADD COLUMN IF NOT EXISTS max_fanout_per_turn integer NOT NULL DEFAULT 6;
ALTER TABLE agent_chain_policies
  ADD COLUMN IF NOT EXISTS max_edge_repeats_per_root integer NOT NULL DEFAULT 3;
ALTER TABLE agent_chain_policies
  ADD COLUMN IF NOT EXISTS max_delegations_per_root integer NOT NULL DEFAULT 64;
ALTER TABLE agent_chain_policies
  ADD COLUMN IF NOT EXISTS human_gate_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE agent_chain_policies
  DROP CONSTRAINT IF EXISTS agent_chain_policies_delegation_caps_check;
ALTER TABLE agent_chain_policies
  ADD CONSTRAINT agent_chain_policies_delegation_caps_check CHECK (
    max_fanout_per_turn BETWEEN 1 AND 100
    AND max_edge_repeats_per_root BETWEEN 1 AND 1000
    AND max_delegations_per_root BETWEEN 1 AND 10000
  );

UPDATE agent_chain_policies
   SET cycle_cut_enabled = true, updated_at = now()
 WHERE id = 'default' AND cycle_cut_enabled = false;
