-- Reversa de 018_terminal_recovery_backfill.sql (ejecución manual).
-- Elimina filas de dead_letters creadas por el backfill que no hayan sido resueltas.

BEGIN;

DELETE FROM dead_letters
WHERE reason LIKE 'backfill 018 (%'
  AND resolved_at IS NULL
  AND delivery_id IS NOT NULL;

DELETE FROM audit_events
WHERE action = 'migration.dead_letter_backfill'
  AND metadata->>'migration' = '018_terminal_recovery_backfill';

DELETE FROM schema_migrations WHERE version = '018_terminal_recovery_backfill.sql';

COMMIT;
