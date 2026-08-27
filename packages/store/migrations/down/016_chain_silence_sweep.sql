-- Reversa de 016_chain_silence_sweep.sql (ejecución manual).

BEGIN;

DROP INDEX IF EXISTS messages_origin_created_idx;
DROP INDEX IF EXISTS adapter_outbox_relay_root_idx;
DROP INDEX IF EXISTS messages_chain_root_idx;
DROP INDEX IF EXISTS agent_output_materializations_root_idx;

DROP TABLE IF EXISTS agent_chain_closures;

DELETE FROM schema_migrations WHERE version='016_chain_silence_sweep.sql';

COMMIT;
