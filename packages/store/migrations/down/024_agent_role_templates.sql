-- Reversa de 024_agent_role_templates.sql (ejecución manual).

BEGIN;

-- Eliminación de triggers y funciones de coherencia antes de modificar agents.
DROP TRIGGER IF EXISTS agents_role_brief_journal ON agents;
DROP TRIGGER IF EXISTS agents_role_template_coherence ON agents;
DROP FUNCTION IF EXISTS cauce_agents_role_brief_journal();
DROP FUNCTION IF EXISTS cauce_agents_role_template_coherence();

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_role_template_fk;
DROP INDEX IF EXISTS agents_role_template_idx;
ALTER TABLE agents DROP COLUMN IF EXISTS role_template_slug;

DROP TABLE IF EXISTS agent_role_brief_history;
DROP TABLE IF EXISTS agent_role_templates;

DELETE FROM schema_migrations WHERE version='024_agent_role_templates.sql';

COMMIT;
