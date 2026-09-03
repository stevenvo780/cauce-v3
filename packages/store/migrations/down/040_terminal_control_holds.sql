-- Retira el arriendo del control de la TUI.
--
-- Rechaza si queda una sesión en modo `harness_rw`: estrechar el CHECK con esa fila viva dejaría
-- la tabla con un valor que su propia restricción prohíbe, y la siguiente escritura de esa fila
-- —cerrar la sesión, contar bytes— fallaría sin relación aparente con el rollback. Primero se
-- cierran las sesiones escribibles, después se baja el esquema.
--
-- Como en todo el juego, el rollback de verdad de la base es el backup; esto existe para que el
-- juego de migraciones tenga inversa probada.

SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_040);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations WHERE version>'040_terminal_control_holds.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 040 while a later migration is present';
  END IF;

  IF EXISTS (SELECT 1 FROM terminal_sessions WHERE mode='harness_rw') THEN
    RAISE EXCEPTION 'cannot downgrade schema 040 while a writable TUI session exists';
  END IF;
END
$$;

DROP TABLE IF EXISTS terminal_control_holds;

ALTER TABLE terminal_sessions DROP COLUMN IF EXISTS window_extended_to;

ALTER TABLE terminal_sessions DROP CONSTRAINT IF EXISTS terminal_sessions_mode_check_v2;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='terminal_sessions'::regclass AND conname='terminal_sessions_mode_check'
  ) THEN
    ALTER TABLE terminal_sessions
      ADD CONSTRAINT terminal_sessions_mode_check CHECK (mode IN ('shell','harness'));
  END IF;
END
$$;

DELETE FROM schema_migrations WHERE version='040_terminal_control_holds.sql';
