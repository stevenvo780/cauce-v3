-- Reversa de 019_delegation_discipline.sql (ejecución manual).

BEGIN;

-- 1. Cierre de compuertas abiertas.
UPDATE agent_chain_gates SET status='cancelled', updated_at=now() WHERE status='open';

DROP INDEX IF EXISTS agent_chain_gates_tenant_idx;
DROP INDEX IF EXISTS agent_chain_gates_open_idx;
DROP INDEX IF EXISTS agent_chain_gates_open_root_idx;
DROP TABLE IF EXISTS agent_chain_gates;

-- 2. Contador de aristas.
DROP INDEX IF EXISTS agent_chain_edge_uses_last_used_idx;
DROP TABLE IF EXISTS agent_chain_edge_uses;

-- 3. Delegaciones en agent_chain_progress.
ALTER TABLE agent_chain_progress
  DROP CONSTRAINT IF EXISTS agent_chain_progress_delegations_check;
ALTER TABLE agent_chain_progress
  DROP COLUMN IF EXISTS delegations;

-- 4. Política de delegaciones.
ALTER TABLE agent_chain_policies
  DROP CONSTRAINT IF EXISTS agent_chain_policies_delegation_caps_check;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS human_gate_enabled;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS max_delegations_per_root;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS max_edge_repeats_per_root;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS max_fanout_per_turn;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS delegation_caps_enabled;

-- 5. Dominio de rechazo.
UPDATE agent_output_materializations
   SET rejection_code='invalid_output'
 WHERE rejection_code IN (
   'fanout_exceeded','edge_repeat_exceeded','root_budget_exhausted','chain_gated','human_gate_opened'
 );

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

DELETE FROM schema_migrations WHERE version='019_delegation_discipline.sql';

COMMIT;
