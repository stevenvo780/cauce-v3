-- Reversa de 019_delegation_discipline.sql
--
-- El runner (applyMigrations en packages/store/src/db.ts) NO lee este directorio: aplica en
-- orden alfabético los .sql de migrations/ e indexa por nombre de archivo. Esto se corre a mano.
--
-- ANTES DE CORRERLO: el apagado en caliente no necesita nada de esto. Si el problema es que un
-- tope corta trabajo legítimo, la salida barata es una sola sentencia y NO tocar el esquema:
--
--   UPDATE agent_chain_policies
--      SET delegation_caps_enabled=false, human_gate_enabled=false, cycle_cut_enabled=false,
--          updated_at=now()
--    WHERE id='default';
--
-- Bajar el esquema sólo tiene sentido si hay que retroceder la IMAGEN a una anterior a 019.
-- Ojo: la imagen vieja no conoce los códigos de rechazo nuevos, así que hay que devolver el
-- CHECK a su dominio de 008 y, si quedaron filas con los códigos nuevos, hay que decidir qué
-- hacer con ellas (el bloque de abajo las normaliza a 'invalid_output', que la imagen vieja sí
-- entiende, en vez de borrar evidencia).

BEGIN;

-- 1. Gates abiertos: no se pierden en silencio. Se cierran como 'cancelled' para que una lista
--    posterior pueda mostrarlos, y sus cadenas dejen de estar suspendidas.
UPDATE agent_chain_gates SET status='cancelled', updated_at=now() WHERE status='open';

DROP INDEX IF EXISTS agent_chain_gates_tenant_idx;
DROP INDEX IF EXISTS agent_chain_gates_open_idx;
DROP INDEX IF EXISTS agent_chain_gates_open_root_idx;
DROP TABLE IF EXISTS agent_chain_gates;

-- 2. Contador de aristas.
DROP INDEX IF EXISTS agent_chain_edge_uses_last_used_idx;
DROP TABLE IF EXISTS agent_chain_edge_uses;

-- 3. Combustible por raíz.
ALTER TABLE agent_chain_progress
  DROP CONSTRAINT IF EXISTS agent_chain_progress_delegations_check;
ALTER TABLE agent_chain_progress
  DROP COLUMN IF EXISTS delegations;

-- 4. Política.
ALTER TABLE agent_chain_policies
  DROP CONSTRAINT IF EXISTS agent_chain_policies_delegation_caps_check;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS human_gate_enabled;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS max_delegations_per_root;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS max_edge_repeats_per_root;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS max_fanout_per_turn;
ALTER TABLE agent_chain_policies DROP COLUMN IF EXISTS delegation_caps_enabled;

-- 5. Dominio de rechazo: vuelve al de 008. Las filas escritas por 019 se normalizan primero,
--    porque el CHECK viejo las rechazaría y el ALTER fallaría.
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

-- 6. cycle_cut_enabled queda como esté: 019 lo encendió, pero apagarlo o no es una decisión de
--    operación, no de esquema. Si se quiere el estado exacto previo a 019:
--   UPDATE agent_chain_policies SET cycle_cut_enabled=false, updated_at=now() WHERE id='default';

DELETE FROM schema_migrations WHERE version='019_delegation_discipline.sql';

COMMIT;
