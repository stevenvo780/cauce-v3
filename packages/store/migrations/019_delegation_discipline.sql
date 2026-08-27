-- Disciplina de delegación: cortar el paseo aleatorio y sacar la espera humana del bus.
--
-- MEDICIÓN (prod, 7 días, agent_output_materializations status='materialized', n=2093):
--
--   * 2093 delegaciones repartidas en 168 raíces. UNA sola raíz produjo 1425 (68%) en 38 h;
--     la segunda más grande, 92. Las otras 166 raíces suman <=30 delegaciones cada una.
--   * 583 aristas distintas (raíz, emisor, destino). 460 se usaron UNA vez. Pero 63 aristas se
--     repitieron 4 veces o más dentro de la MISMA raíz, y esas 63 explican 1306 de las 2093
--     delegaciones (62%). En la raíz grande, argos le mandó el mismo trabajo a kant 148 veces,
--     a iza 137, a kratos 126, a seneca 123, a vulcano 98...
--   * hop_count tiene forma de campana cortada en el techo (pico en 9 de un presupuesto de 16),
--     que es la firma de un paseo aleatorio, no de un árbol de delegación.
--   * 1286 de las 2093 (61%) nacieron sobre un turno de continuación `agent.response`: el
--     coordinador recibe la respuesta y vuelve a delegar.
--
-- Por qué ningún guarda anterior lo veía, que es el punto:
--   * el guarda de ciclo por camino de ANTEPASADOS (`visited_path`, 008) no aplica: cuando C
--     delega en X y X le responde, X nunca fue antepasado de C.
--   * el guarda de `actor_alias` sí tapaba la repetición INMEDIATA, y se nota: sólo 129 de las
--     1411 delegaciones de la raíz grande repitieron el destino anterior. El paseo lo esquiva
--     ROTANDO entre 12 pares. Contar la ARISTA por raíz es lo único que ve esa rotación.
--
-- De ahí salen los tres topes de abajo. Cada uno se eligió para dejar intacto el trabajo real
-- medido y cortar sólo la cola:
--
--   max_delegations_per_root   = 64  -> 2,1x la raíz legítima más grande observada (30).
--                                       Toca 2 de 168 raíces (1,2%); corta 1389 entregas (66%).
--   max_edge_repeats_per_root  = 3   -> deja enteras 520 de 583 aristas (89,2%).
--                                       Toca 63 aristas; corta 1306 entregas (62%).
--   max_fanout_per_turn        = 6   -> 780 de 818 turnos internos (95,4%) ya emiten <=6.
--                                       Sólo aplica a turnos internos (hop_count>=2): los 14
--                                       turnos con abanico >6 del turno raíz son `@all` en
--                                       hop_count=1 y quedan intactos. Corta 53 entregas
--                                       (3,0% del tráfico interno).
--
-- Todo es aditivo. Ninguna columna nueva es NOT NULL sin default no volátil, así que los ALTER
-- son operaciones de catálogo y no reescriben ninguna tabla.

-- ---------------------------------------------------------------------------------------------
-- 1. Dominio de rechazo durable
-- ---------------------------------------------------------------------------------------------
-- El dominio viejo es subconjunto estricto del nuevo, así que toda fila existente ya satisface
-- el predicado nuevo; NOT VALID evita el escaneo completo bajo ACCESS EXCLUSIVE dentro de la
-- única transacción que aplica todas las migraciones. Mismo criterio que 008.
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
      -- nuevos en 019
      'fanout_exceeded',
      'edge_repeat_exceeded',
      'root_budget_exhausted',
      'chain_gated',
      'human_gate_opened'
    )
  ) NOT VALID;

-- ---------------------------------------------------------------------------------------------
-- 2. Combustible por raíz
-- ---------------------------------------------------------------------------------------------
-- Vive en agent_chain_progress y no en una tabla nueva a propósito: ya está indexada por
-- root_message_id y ya es la fila que insertProgressRelay bloquea. Reusarla hace que dos ACK
-- concurrentes de la misma cadena serialicen sobre UNA sola fila, sin invertir ningún orden de
-- candados (hay un solo objeto en juego).
ALTER TABLE agent_chain_progress
  ADD COLUMN IF NOT EXISTS delegations integer NOT NULL DEFAULT 0;
ALTER TABLE agent_chain_progress
  DROP CONSTRAINT IF EXISTS agent_chain_progress_delegations_check;
ALTER TABLE agent_chain_progress
  ADD CONSTRAINT agent_chain_progress_delegations_check CHECK (delegations >= 0) NOT VALID;

-- ---------------------------------------------------------------------------------------------
-- 3. Contador de aristas por raíz
-- ---------------------------------------------------------------------------------------------
-- La reserva es el propio INSERT ... ON CONFLICT DO UPDATE ... WHERE uses < tope: si el WHERE
-- no se cumple no vuelve ninguna fila Y el contador NO avanza, así que un rechazo no consume
-- presupuesto. Dos ACK concurrentes de la misma arista serializan sobre la fila.
--
-- root_message_id NO tiene foreign key, por el mismo motivo que agent_chain_progress: se deriva
-- de una correlación cuya FORMA se valida pero cuya EXISTENCIA no, y un REFERENCES convertiría
-- una correlación forjada en una violación de constraint que aborta la transacción del ACK.
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

-- ---------------------------------------------------------------------------------------------
-- 4. Compuerta humana
-- ---------------------------------------------------------------------------------------------
-- "Monitoreá si Steven responde" NO es una delegación: Cauce es por eventos y ningún agente
-- hace polling, así que esa entrega no puede completarse nunca. Hoy eso termina en entregas
-- muertas (23+ desde el 24-jul en un solo gate de facturación). Acá deja de ser una entrega y
-- pasa a ser una FILA con estado, visible en una lista, que cuando el humano contesta emite
-- UNA entrega de reanudación.
--
-- El índice único parcial por raíz es lo que garantiza "la pregunta sale UNA sola vez": no
-- puede haber dos gates abiertos de la misma cadena, y mientras haya uno el store rechaza
-- durablemente toda delegación nueva de esa raíz con 'chain_gated'.
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
  -- Correlación completa de la rama suspendida (raíz, hop_count, hop_budget, visited_path).
  -- Es lo que permite que la reanudación siga la cadena con su presupuesto intacto en vez de
  -- arrancar una cadena nueva.
  correlation jsonb NOT NULL CHECK (jsonb_typeof(correlation) = 'object'),
  -- Origen del turno que abrió el gate, para poder relayar la pregunta al canal humano.
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
  -- Un ACK repetido del mismo output no abre un gate nuevo.
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

-- ---------------------------------------------------------------------------------------------
-- 5. Política versionada
-- ---------------------------------------------------------------------------------------------
-- A DIFERENCIA de 008 y 014, estas banderas nacen ENCENDIDAS. Es deliberado y el dueño lo pidió
-- explícitamente ("lo funcional es la prioridad ... ahorita no logran prácticamente nada"): un
-- tope apagado no arregla nada. Los números están elegidos contra la distribución real medida
-- (ver cabecera) de modo que el 98,8% de las raíces, el 95,4% de las aristas y el 95,4% de los
-- turnos internos NO se tocan.
--
-- Apagado de emergencia, sin rollback de imagen y sin migración:
--   UPDATE agent_chain_policies SET delegation_caps_enabled=false, updated_at=now() WHERE id='default';
--   UPDATE agent_chain_policies SET human_gate_enabled=false,     updated_at=now() WHERE id='default';
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

-- El guarda de ciclo por camino de antepasados queda encendido junto con los topes.
--
-- Su `false` NO era una decisión informada del operador: 008 lo dejó apagado porque el guarda
-- estaba CIEGO (`visited_path` se reiniciaba en largo 1 en cada continuación; medido en prod
-- como `hop_count=16 | vp_len=1 | corr_has_vp=f`). El respaldo que lo cura ya está en esta misma
-- línea (ver el comentario de `visited_path` en materializeAgentOutputs). Este UPDATE corre una
-- sola vez porque el runner indexa las migraciones por NOMBRE de archivo.
--
-- Para volver atrás sólo esto:
--   UPDATE agent_chain_policies SET cycle_cut_enabled=false, updated_at=now() WHERE id='default';
UPDATE agent_chain_policies
   SET cycle_cut_enabled = true, updated_at = now()
 WHERE id = 'default' AND cycle_cut_enabled = false;
