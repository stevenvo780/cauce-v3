-- Reversa de 017_terminal_recovery_backfill.sql
--
-- La 016 no hace DDL: sólo inserta filas de rescate en `dead_letters` y una fila de auditoría.
-- Revertirla es borrar exactamente esas filas, y se identifican sin ambigüedad por el prefijo
-- 'backfill 016 (' que la propia migración escribe en `reason`.
--
-- SE PROTEGE LO QUE YA SE USÓ. Una fila con `resolved_at` NO SE BORRA: significa que un operador
-- ya apretó replay sobre ella y que existe un clon de la entrega corriendo o corrido. Borrarla
-- dejaría a `replayDelivery` sin el ancla que usa para detectar el replay legado
-- (`legacyReplay`), y ese clon quedaría huérfano. Revertir una migración de rescate no puede
-- borrar la evidencia de un rescate consumado.
--
-- CONSECUENCIA DE APLICAR ESTA REVERSA: las entregas terminales que vuelvan a quedarse sin fila
-- pierden otra vez el botón de replay. No se pierde trabajo (la entrega y su mensaje siguen
-- intactos), pero se vuelve al estado en el que 419 entregas de producción eran irrecuperables.
--
-- Idempotente: correrla dos veces borra cero filas la segunda vez.

DELETE FROM dead_letters
WHERE reason LIKE 'backfill 016 (%'
  AND resolved_at IS NULL
  AND delivery_id IS NOT NULL;

DELETE FROM audit_events
WHERE action = 'migration.dead_letter_backfill'
  AND metadata->>'migration' = '017_terminal_recovery_backfill';

DELETE FROM schema_migrations WHERE version = '017_terminal_recovery_backfill.sql';
