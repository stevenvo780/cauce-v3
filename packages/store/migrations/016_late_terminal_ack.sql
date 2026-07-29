-- 016: aceptar el ACK terminal que llega tarde, con la respuesta adentro.
--
-- Hasta acá `ackDelivery` usaba UN solo predicado (`exactClaim`) para decidir dos cosas
-- distintas: si el ACK podía modificar la fila, y si el RESULTADO valía algo. El plazo
-- (`ack_deadline_at`) es la caducidad de la EXCLUSIVIDAD, no la del resultado: el trabajo ya se
-- hizo y la cuota del modelo ya se pagó. Medido sobre esta misma base el 2026-07-29, ventana de
-- 7 días: 495 ACKs 'done' descartados sobre entregas que terminaron `dead`, 387 de ellos con un
-- `reply` no vacío — respuestas reales que el humano nunca vio.
--
-- Estas dos columnas son la marca de "esta entrega ya asentó un resultado tardío". Es lo que
-- garantiza que haya COMO MUCHO UN rescate por entrega: sin ella, una entrega que quedó `dead`
-- podría aceptar un tardío, volver a quedar `dead` por un 'failed' tardío, y aceptar otro. Con
-- ella, el segundo se rechaza con el `ownership_lost` de siempre.
--
-- No hace falta backfill y no se pide ninguno. El predicado de seguridad es
-- `status NOT IN ('done','failed') AND late_result_at IS NULL`: las entregas ya cerradas por un
-- ACK aplicado quedan protegidas por el `status`, sin depender de la columna nueva. Las que
-- están en `dead` quedan con `late_result_at` NULL y por lo tanto rescatables — que es
-- exactamente lo que este trabajo quiere.
--
-- Las dos son `ADD COLUMN ... IF NOT EXISTS` sin DEFAULT ni NOT NULL: en PostgreSQL eso es una
-- operación de catálogo, instantánea y sin reescribir la tabla. No se agregan índices: nada en
-- el camino caliente busca por estas columnas, y construir un índice dentro de la transacción
-- del runner es la clase de cosa que deja al gateway y al dispatcher sin arrancar.

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS late_result_at timestamptz;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS late_result_attempt integer;

COMMENT ON COLUMN deliveries.late_result_at IS
  'Instante en que se aceptó un ACK terminal fuera de plazo para esta entrega. NULL = ninguno.';
COMMENT ON COLUMN deliveries.late_result_attempt IS
  'Intento al que pertenecía ese ACK tardío; puede ser menor que deliveries.attempt.';
