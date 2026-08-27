-- Reversa de 017_late_terminal_ack.sql (ejecución manual).

BEGIN;

ALTER TABLE deliveries DROP COLUMN IF EXISTS cancelled_at;

ALTER TABLE deliveries DROP COLUMN IF EXISTS late_result_attempt;
ALTER TABLE deliveries DROP COLUMN IF EXISTS late_result_at;

DELETE FROM schema_migrations WHERE version='017_late_terminal_ack.sql';

COMMIT;
