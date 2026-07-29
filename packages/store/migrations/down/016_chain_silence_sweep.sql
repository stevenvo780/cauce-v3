-- Reversa de 016_chain_silence_sweep.sql (renumerada en la integracion del 2026-07-29; nacio 014).
--
-- Aplicar SOLO con el dispatcher parado o con CHAIN_SWEEP_MS=0: sin la tabla el vigía
-- pierde su ancla de idempotencia y podría volver a avisar de raíces ya cerradas.
--
-- El barrido no muta ninguna fila preexistente (sólo INSERTA en agent_chain_closures,
-- adapter_outbox y audit_events), así que revertir no deja datos incoherentes: los avisos
-- ya emitidos siguen en el outbox y en la auditoría, que es donde tienen que estar.
--
-- El borrado de la fila del registro NO es opcional, y hasta la consolidación del 2026-07-29 vivía
-- acá arriba DENTRO de un comentario ("recordá borrarla"), es decir: no se ejecutaba. El efecto de
-- esa omisión no es cosmético. Mientras `schema_migrations` diga que la 016 está aplicada, el
-- runner no la vuelve a correr NUNCA, así que la base se queda sin `agent_chain_closures` pero
-- convencida de tenerla. El código que la consulta falla entonces con 42703 y, como ese camino
-- vive dentro de la transacción del ACK, TODO ACK falla: el bus se queda mudo y no hay salida sin
-- editar el registro a mano. Ahora va como sentencia de verdad, y dentro de la misma transacción
-- que los DROP, que es lo que garantiza que esquema y registro no puedan quedar en desacuerdo ni
-- por un instante.
BEGIN;

DROP INDEX IF EXISTS messages_origin_created_idx;
DROP INDEX IF EXISTS adapter_outbox_relay_root_idx;
DROP INDEX IF EXISTS messages_chain_root_idx;
DROP INDEX IF EXISTS agent_output_materializations_root_idx;

DROP TABLE IF EXISTS agent_chain_closures;

DELETE FROM schema_migrations WHERE version='016_chain_silence_sweep.sql';

COMMIT;
