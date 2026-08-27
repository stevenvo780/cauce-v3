-- Coalescencia de avisos de fracaso hacia el padre.
--
-- RENUMERADA EN LA CONSOLIDACIÓN DEL 2026-07-29: nació 014 en `fix/coalescer-avisos-fallo` y
-- chocaba con `014_observability_retention.sql`, que nació 014 en paralelo en otra rama. El runner
-- (`packages/store/src/db.ts`) indexa por NOMBRE de archivo y ordena por nombre, así que el número
-- sólo define el ORDEN de aplicación. Ésta no depende de ninguna otra migración de la serie 014+:
-- crea sus dos tablas nuevas y agrega dos columnas a `agent_chain_policies`, que existe desde la
-- 008, y ninguna migración posterior mira `failure_coalesce_*` ni `agent_failure_notices*`. Por eso
-- puede correr al final sin cambiar de significado. Mismo criterio que ya había usado la 018.
--
-- El 27-jul-2026 un solo mensaje de Telegram produjo 2801 entregas en 35 h. El 84% de la cola
-- de `argos` (223 de 265) no era trabajo: era el mismo aviso "X could not complete the delegated
-- request" repetido, porque cada fracaso de un hijo se materializa como una entrega NUEVA hacia
-- el padre y nada mira si ya se le dijo lo mismo hace un minuto. El fracaso era su propio
-- combustible: el aviso llegaba a un padre saturado, el padre no lo podía procesar, y eso
-- generaba más avisos.
--
-- Estas dos tablas separan las dos cosas que hoy están fundidas en una sola entrega:
--   * "el padre tiene que enterarse"  -> sigue siendo una entrega, pero UNA por ventana.
--   * "el detalle de cada fracaso"    -> deja de ser una entrega y pasa a ser una fila.
-- Nada se pierde; lo que se corta es la amplificación.
--
-- Todo es aditivo y ninguna columna nueva es NOT NULL sin default, así que el ALTER de abajo
-- es una operación de catálogo y nunca reescribe la tabla.

-- Un cubo por (raíz de la cadena, padre, hijo, causa). La causa entra en la clave a propósito:
-- agregar dos fracasos con causas DISTINTAS escondería un problema nuevo detrás de uno viejo,
-- que es exactamente el modo de fallo que esta tabla existe para evitar. Dos causas distintas
-- del mismo hijo son dos cubos y por lo tanto dos avisos.
--
-- root_message_id NO tiene foreign key, por el mismo motivo que agent_chain_progress: se deriva
-- de una correlación cuya forma se valida pero cuya existencia no, y un REFERENCES convertiría
-- una correlación forjada en una violación de constraint que aborta la transacción del ACK
-- entera (y con ella el tick del reaper).
CREATE TABLE IF NOT EXISTS agent_failure_notices (
  id bigserial PRIMARY KEY,
  root_message_id uuid NOT NULL,
  parent_tenant text NOT NULL,
  parent_alias text NOT NULL,
  child_tenant text NOT NULL,
  child_alias text NOT NULL,
  -- Huella normalizada de la causa (ver failureSignature() en repository.ts): el código de error
  -- si lo hay, o el texto del error con dígitos, uuids y hexadecimales enmascarados, para que
  -- "attempt 3" y "attempt 4" del mismo fallo caigan en el mismo cubo.
  failure_signature text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_expires_at timestamptz NOT NULL,
  -- Cuántas entregas produjo este cubo de verdad (el numerador del ahorro).
  notices_emitted integer NOT NULL DEFAULT 0 CHECK (notices_emitted >= 0),
  -- Cuántos fracasos cayeron acá, se hayan entregado o no (el denominador).
  --
  -- La resta total_failures - notices_emitted es el número que el aviso le anuncia al padre:
  -- cuántos fracasos NO viajaron con entrega propia. No hace falta guardarlo aparte, y no
  -- guardarlo evita que dos contadores se puedan contradecir.
  total_failures integer NOT NULL DEFAULT 0 CHECK (total_failures >= 0),
  -- La decisión de emitir o plegar se toma dentro del mismo INSERT ... ON CONFLICT DO UPDATE que
  -- mueve los contadores, porque RETURNING sólo ve la fila NUEVA y hace falta comparar contra la
  -- vieja. Esta columna es cómo esa decisión sale de la sentencia sin una segunda consulta que
  -- abriría una carrera entre dos ACKs concurrentes del mismo cubo.
  last_failure_emitted boolean NOT NULL DEFAULT true,
  last_notice_message_id uuid,
  last_notice_delivery_id uuid,
  -- El texto del último aviso SIN la cláusula agregada. Mientras el padre no haya reclamado esa
  -- entrega, cada fracaso que se pliega reescribe el texto a partir de esta base, así que el
  -- aviso que el padre termina leyendo dice "5 fracasos, 4 avisos plegados" y no "1". Guardar la
  -- base (en vez de reparsear el mensaje) hace que reescribir sea idempotente: nunca se apila
  -- una segunda cláusula sobre la primera.
  last_notice_base_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_failure_notices_key UNIQUE (
    root_message_id, parent_tenant, parent_alias, child_tenant, child_alias, failure_signature
  )
);

-- Para la poda por antigüedad y para "qué cubos siguen quemando" en la consola.
CREATE INDEX IF NOT EXISTS agent_failure_notices_updated_idx
  ON agent_failure_notices (updated_at);
CREATE INDEX IF NOT EXISTS agent_failure_notices_parent_idx
  ON agent_failure_notices (parent_tenant, parent_alias, updated_at DESC);

-- El detalle que deja de viajar como entrega. Sin esto, coalescer sería perder información:
-- acá queda una fila por CADA fracaso, plegado o no, con su causa cruda.
--
-- La clave primaria es el ACK que produjo el fracaso — (entrega, intento) —, no el hijo, porque
-- una continuación agent.response ACKea una entrega distinta de la del hijo original. Esa clave
-- hace que un reintento de la misma materialización sea un no-op y no infle los contadores.
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
  -- false = este fracaso viajó como entrega propia; true = quedó plegado en el aviso agregado.
  coalesced boolean NOT NULL DEFAULT false,
  -- El aviso concreto bajo el cual el padre puede encontrar este fracaso.
  notice_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ack_delivery_id, ack_attempt)
);

CREATE INDEX IF NOT EXISTS agent_failure_notice_events_notice_idx
  ON agent_failure_notice_events (notice_id, created_at);
CREATE INDEX IF NOT EXISTS agent_failure_notice_events_child_idx
  ON agent_failure_notice_events (child_delivery_id);

-- Interruptor y ventana, en la política versionada que ya tiene preview, auditoría y rollback,
-- para que apagar la coalescencia en caliente sea una mutación auditada y no un redeploy.
--
-- 900 s: tres veces el techo del backoff de reintento por timeout (timeoutRetryBackoffSeconds
-- satura en 300 s) y la mitad del plazo de ACK real de producción (1800 s). Más corta no plegaría
-- nada — los reintentos del mismo fracaso llegan cada 5 min —; más larga que el plazo de ACK
-- podría tapar un ciclo de timeout entero. Con 900 s el padre sigue recibiendo hasta 4 avisos por
-- hora y por causa mientras la tormenta arde (sabe que sigue ardiendo), en vez de los ~80/h que
-- se midieron el 27-jul.
--
-- Nace ENCENDIDA, a diferencia del resto de los flags de 008: aquellos agregaban comportamiento
-- nuevo y opcional, éste apaga una amplificación que ya tumbó la cola de un alias en producción.
-- Desplegarlo apagado sería desplegar la nada.
ALTER TABLE agent_chain_policies
  ADD COLUMN IF NOT EXISTS failure_coalesce_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE agent_chain_policies
  ADD COLUMN IF NOT EXISTS failure_coalesce_window_seconds integer NOT NULL DEFAULT 900;

-- NOT VALID por el mismo motivo que en 008: evita el scan completo bajo ACCESS EXCLUSIVE dentro
-- de la transacción única que aplica todas las migraciones. Las filas existentes ya cumplen,
-- porque la columna acaba de nacer con default 900.
ALTER TABLE agent_chain_policies
  DROP CONSTRAINT IF EXISTS agent_chain_policies_failure_window_check;
ALTER TABLE agent_chain_policies
  ADD CONSTRAINT agent_chain_policies_failure_window_check
  CHECK (failure_coalesce_window_seconds BETWEEN 0 AND 86400) NOT VALID;
