-- Reversa de 020_agent_role_brief.sql (ejecución manual).

BEGIN;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_role_brief_len;
ALTER TABLE agents DROP COLUMN IF EXISTS role_brief;

DELETE FROM schema_migrations WHERE version='020_agent_role_brief.sql';

COMMIT;
