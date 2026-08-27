-- 021: Coalescencia de avisos de fallo hacia el agente padre y tablas de tracking de eventos.

CREATE TABLE IF NOT EXISTS agent_failure_notices (
  id bigserial PRIMARY KEY,
  root_message_id uuid NOT NULL,
  parent_tenant text NOT NULL,
  parent_alias text NOT NULL,
  child_tenant text NOT NULL,
  child_alias text NOT NULL,
  -- Firma normalizada de la causa del fallo.
  failure_signature text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_expires_at timestamptz NOT NULL,
  -- Cantidad de entregas de aviso efectivamente emitidas.
  notices_emitted integer NOT NULL DEFAULT 0 CHECK (notices_emitted >= 0),
  -- Total de fallos observados dentro de la ventana.
  total_failures integer NOT NULL DEFAULT 0 CHECK (total_failures >= 0),
  -- Indicador de si el último fallo produjo una entrega o fue coalescido.
  last_failure_emitted boolean NOT NULL DEFAULT true,
  last_notice_message_id uuid,
  last_notice_delivery_id uuid,
  -- Texto base del último aviso para reconstrucción idempotente.
  last_notice_base_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_failure_notices_key UNIQUE (
    root_message_id, parent_tenant, parent_alias, child_tenant, child_alias, failure_signature
  )
);

-- Índices de búsqueda y purga por antigüedad.
CREATE INDEX IF NOT EXISTS agent_failure_notices_updated_idx
  ON agent_failure_notices (updated_at);
CREATE INDEX IF NOT EXISTS agent_failure_notices_parent_idx
  ON agent_failure_notices (parent_tenant, parent_alias, updated_at DESC);

-- Registro detallado por evento individual de fallo.
CREATE TABLE IF NOT EXISTS agent_failure_notice_events (
  ack_delivery_id uuid NOT NULL,
  ack_attempt integer NOT NULL,
  notice_id bigint REFERENCES agent_failure_notices(id) ON DELETE CASCADE,
  child_delivery_id uuid NOT NULL,
  child_tenant text NOT NULL,
  child_alias text NOT NULL,
  outcome text NOT NULL,
  error text,
  error_code text,
  -- false = emitido como entrega propia; true = coalescido en aviso agregado.
  coalesced boolean NOT NULL DEFAULT false,
  -- Identificador del mensaje de aviso en que se integró este fallo.
  notice_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ack_delivery_id, ack_attempt)
);

CREATE INDEX IF NOT EXISTS agent_failure_notice_events_notice_idx
  ON agent_failure_notice_events (notice_id, created_at);
CREATE INDEX IF NOT EXISTS agent_failure_notice_events_child_idx
  ON agent_failure_notice_events (child_delivery_id);

ALTER TABLE agent_chain_policies
  ADD COLUMN IF NOT EXISTS failure_coalesce_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE agent_chain_policies
  ADD COLUMN IF NOT EXISTS failure_coalesce_window_seconds integer NOT NULL DEFAULT 900;

ALTER TABLE agent_chain_policies
  DROP CONSTRAINT IF EXISTS agent_chain_policies_failure_window_check;
ALTER TABLE agent_chain_policies
  ADD CONSTRAINT agent_chain_policies_failure_window_check
  CHECK (failure_coalesce_window_seconds BETWEEN 0 AND 86400) NOT VALID;
