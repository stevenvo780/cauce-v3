-- Tope ABSOLUTO de vida de un intento en vuelo, independiente del `ack_deadline_at` renovable.
--
-- POR QUÉ EXISTE
-- `ack_deadline_at` es DESLIZANTE: cada ACK 'started' lo reprograma a now()+CAUCE_ACK_DEADLINE_MS
-- (30 min en producción) y el adaptador emite ese ACK cada 60 s con independencia TOTAL de si el
-- harness avanza — le basta con tener el socket abierto. El WHERE del reaper mira
-- `COALESCE(ack_deadline_at,...) <= now()`, así que con un latido sano la condición NUNCA se
-- cumple y la entrega no expira jamás. Medido el 2026-07-29: `janus` sostuvo 2 entregas en
-- 'started' más de 4 h con el harness muerto y bloqueó por head-of-line otras 4 durante 11,8 h,
-- con el reaper SANO (1.184.426 ticks, 0 errores). `CAUCE_DEFAULT_TIMEOUT_MS` (24 h) tampoco
-- actuaba. Un intento tiene que tener un techo que ninguna renovación pueda mover.
--
-- POR QUÉ 014 Y NO 011
-- Producción ya aplicó 011_terminal_sessions.sql, 012_execution_started_marker.sql y
-- 013_quota_observation.sql (schema_migrations, 2026-07-26/27). El runner indexa por NOMBRE DE
-- ARCHIVO y corre todo dentro de UNA transacción con pg_advisory_xact_lock: un 011 nuevo se
-- ejecutaría igual y su `ADD COLUMN execution_started_at` chocaría con la columna que ya creó
-- 012, abortando la transacción entera y dejando al gateway y al dispatcher sin arrancar.
--
-- POR QUÉ TODO ES IDEMPOTENTE
-- Esta migración tiene que poder correr sobre tres esquemas distintos: producción (que ya tiene
-- `execution_started_at` de 012 con 1.061 filas pobladas), una base fresca de esta rama (que no
-- tiene 011-013) y una base ya migrada. `IF NOT EXISTS` + guardas de catálogo es lo que hace que
-- los tres casos terminen en el mismo esquema sin destruir nada.
--
-- `execution_started_at` NO se recrea ni se re-comenta si ya existe: pertenece a 012 y su
-- semántica es "el harness ARRANCÓ de verdad" (el ACK 'started' pelado es una señal FALSA porque
-- el SDK lo emite antes de pedir el candado de sesión). Acá sólo se declara para que una base
-- fresca de esta rama tenga la columna que el código necesita.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;

-- Presupuesto congelado al crear la entrega, no leído en caliente de la configuración: cambiar
-- CAUCE_EXECUTION_LIFETIME_MS no debe matar retroactivamente trabajo que ya está en vuelo, y el
-- valor con el que se mató una entrega tiene que quedar en la fila para poder auditarlo.
-- En PostgreSQL 11+ (prod corre 16.14) ADD COLUMN NOT NULL DEFAULT es metadata-only: no reescribe
-- la tabla ni toma el lock largo, con las 5.270 filas de prod es instantáneo.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS execution_lifetime_ms integer NOT NULL DEFAULT 43200000;

-- ADD CONSTRAINT no admite IF NOT EXISTS: hace falta la guarda explícita para que la migración
-- sea reejecutable. Un presupuesto <= 0 mataría toda entrega en el primer tick del reaper.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.deliveries'::regclass
      AND conname = 'deliveries_execution_lifetime_ms_check'
  ) THEN
    ALTER TABLE deliveries
      ADD CONSTRAINT deliveries_execution_lifetime_ms_check
      CHECK (execution_lifetime_ms > 0);
  END IF;
END $$;

-- Sólo si la columna no tiene comentario: en producción el comentario lo puso 012 y describe la
-- semántica autoritativa (marca de ejecución real, no de admisión). Pisarlo sería perder esa
-- documentación en la única superficie donde el operador la lee (\d+ deliveries).
DO $$
BEGIN
  IF col_description('public.deliveries'::regclass,
                     (SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'public.deliveries'::regclass
                        AND attname = 'execution_started_at')) IS NULL THEN
    COMMENT ON COLUMN deliveries.execution_started_at IS
      'Instante del primer ACK con execution_started=true del intento vigente. NULL = no consta que el harness haya arrancado.';
  END IF;
END $$;

COMMENT ON COLUMN deliveries.execution_lifetime_ms IS
  'Techo absoluto del intento en ms, congelado al crear la entrega. El reloj corre desde COALESCE(execution_started_at,claimed_at) y ninguna renovación de ack_deadline_at lo mueve.';

-- NO se agrega índice a propósito. El reaper filtra por `status IN (leased,accepted,started)`,
-- que ya resuelven los índices parciales existentes (deliveries_inflight_idx y
-- deliveries_open_by_recipient_idx), y el término que agrega esta migración es una expresión
-- sobre columnas de la misma fila que se evalúa sobre el conjunto en vuelo, que es diminuto por
-- construcción (5 filas en prod el 2026-07-29). El término de deadline que ya existía tampoco es
-- sargable (va dentro de un COALESCE), así que el plan no cambia: sigue siendo un index scan por
-- status con filtro. Un índice extra sólo agregaría amplificación de escritura en la tabla más
-- caliente del bus, que se actualiza en cada claim y en cada ACK.

-- Rollback manual: packages/store/migrations/down/014_execution_lifetime.sql
