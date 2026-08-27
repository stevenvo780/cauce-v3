-- Reversa de 023_console_users.sql (ejecución manual).

BEGIN;

DROP INDEX IF EXISTS console_users_active_idx;
DROP INDEX IF EXISTS console_users_email_normalized_key;
DROP TABLE IF EXISTS console_users;

DELETE FROM schema_migrations WHERE version='023_console_users.sql';

COMMIT;
