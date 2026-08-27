-- Reversa de 026_agent_profile.sql (ejecución manual).

BEGIN;

DROP TABLE IF EXISTS agent_profiles;

DROP FUNCTION IF EXISTS cauce_text_items_ok(text[], integer);
DROP FUNCTION IF EXISTS cauce_utf16_units(text);

DELETE FROM schema_migrations WHERE version='026_agent_profile.sql';

COMMIT;
