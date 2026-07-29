-- Reversa de 015_chain_silence_sweep.sql (renumerada en la integracion del 2026-07-29; nacio 014).
--
-- Aplicar SOLO con el dispatcher parado o con CHAIN_SWEEP_MS=0: sin la tabla el vigía
-- pierde su ancla de idempotencia y podría volver a avisar de raíces ya cerradas.
--
-- El barrido no muta ninguna fila preexistente (sólo INSERTA en agent_chain_closures,
-- adapter_outbox y audit_events), así que revertir no deja datos incoherentes: los avisos
-- ya emitidos siguen en el outbox y en la auditoría, que es donde tienen que estar.
--
-- Recordá borrar la fila del registro para que el runner pueda reaplicarla:
--   DELETE FROM schema_migrations WHERE version='015_chain_silence_sweep.sql';

DROP INDEX IF EXISTS messages_origin_created_idx;
DROP INDEX IF EXISTS adapter_outbox_relay_root_idx;
DROP INDEX IF EXISTS messages_chain_root_idx;
DROP INDEX IF EXISTS agent_output_materializations_root_idx;

DROP TABLE IF EXISTS agent_chain_closures;
