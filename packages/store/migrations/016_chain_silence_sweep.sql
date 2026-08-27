-- 016: Tabla agent_chain_closures e índices de soporte para barrido de cadenas inactivas.

CREATE TABLE IF NOT EXISTS agent_chain_closures (
  root_message_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  adapter text NOT NULL,
  reason text NOT NULL,
  branches integer NOT NULL DEFAULT 0,
  branches_answered integer NOT NULL DEFAULT 0,
  branches_dead integer NOT NULL DEFAULT 0,
  branches_open integer NOT NULL DEFAULT 0,
  dominant_cause text,
  dominant_cause_count integer NOT NULL DEFAULT 0,
  idle_seconds integer NOT NULL DEFAULT 0,
  outbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_chain_closures_reason_check'
      AND conrelid = 'agent_chain_closures'::regclass
  ) THEN
    ALTER TABLE agent_chain_closures
      ADD CONSTRAINT agent_chain_closures_reason_check
      CHECK (reason IN ('settled_without_fanin', 'idle_timeout'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_chain_closures_counts_check'
      AND conrelid = 'agent_chain_closures'::regclass
  ) THEN
    ALTER TABLE agent_chain_closures
      ADD CONSTRAINT agent_chain_closures_counts_check
      CHECK (branches >= 0 AND branches_answered >= 0 AND branches_dead >= 0
             AND branches_open >= 0 AND dominant_cause_count >= 0 AND idle_seconds >= 0);
  END IF;
END
$$;

-- Ramas de una raíz. `materializeAgentFanin` ya filtra por esta expresión en CADA ACK
-- terminal de la flota (ruta caliente), hoy con seq scan sobre agent_output_materializations.
CREATE INDEX IF NOT EXISTS agent_output_materializations_root_idx
  ON agent_output_materializations ((correlation->>'root_message_id'))
  WHERE status = 'materialized';

-- Continuaciones internas (`agent.response`, `agent.fanin`) atadas a una raíz. Es la
-- consulta `pending_responses` del fan-in, también en la ruta caliente.
CREATE INDEX IF NOT EXISTS messages_chain_root_idx
  ON messages ((body->'correlation'->>'root_message_id'))
  WHERE body->'correlation'->>'root_message_id' IS NOT NULL;

-- Relays por raíz. `claimOutbox` compara esta misma COALESCE en tres subconsultas por cada
-- reclamo de relay de Telegram.
CREATE INDEX IF NOT EXISTS adapter_outbox_relay_root_idx
  ON adapter_outbox ((COALESCE(payload#>>'{correlation,root_message_id}',
                               payload#>>'{correlation,message_id}')))
  WHERE kind = 'origin_relay';

-- Ventana de rastreo del vigía: mensajes con origen humano, por fecha.
CREATE INDEX IF NOT EXISTS messages_origin_created_idx
  ON messages (created_at)
  WHERE origin IS NOT NULL;
