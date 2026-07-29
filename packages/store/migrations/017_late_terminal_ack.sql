-- 017: aceptar el ACK terminal que llega tarde, con la respuesta adentro.
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

-- INTEGRACIÓN 2026-07-29 — la tercera columna, y por qué está acá y no en la 018.
--
-- El parche de cancelación (018) y este chocan de frente en un caso concreto: un operador cancela
-- una entrega que un adaptador ya tenía en la mano, la fila queda `dead`, y el harness —que sigue
-- vivo por su cuenta— manda su `done` final con la respuesta adentro. Para el rescate de arriba,
-- `dead` es "la ausencia de un resultado" y eso lo hace rescatable. Para la cancelación, `dead` es
-- una DECISIÓN de una persona.
--
-- Gana la cancelación, y no por gusto: `cancelDelivery` ya le materializó al padre una
-- `agent.response` con `DELIVERY_CANCELLED` y ya le mandó el relay al humano. Si el rescate se
-- aplicara encima, el padre recibiría DOS respuestas por una sola delegación —y el contador de
-- fan-in (`responsesRecorded`) contaría dos— que es justo la corrupción de cadena que deja el
-- fan-in trabado para siempre. El costo de bloquearlo es nulo: cancelar es una acción deliberada
-- y rara; el caso que motiva el rescate (387 respuestas perdidas) es el vencimiento, no la
-- cancelación.
--
-- El marcador va acá, con las otras dos columnas del guarda, porque es el guarda quien lo lee, y
-- porque la 018 no hace DDL a propósito (así no puede impedir el arranque de gateway/dispatcher) y
-- no conviene quitarle esa propiedad. Es la MISMA operación de catálogo que las dos de abajo.
--
-- Se descartó inferirlo: `audit_events` tiene la fila `delivery.cancel` y es durable (la retención
-- sólo poda `delivery.ack`), pero no hay índice por `delivery_id` y la consulta caería en un seq
-- scan sobre 24 MB DENTRO de la transacción del ACK, que sostiene `FOR UPDATE OF d`. Un prefijo
-- sobre `last_error` sería un acuerdo por texto entre dos métodos. Una columna dice la verdad.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS late_result_at timestamptz;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS late_result_attempt integer;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN deliveries.late_result_at IS
  'Instante en que se aceptó un ACK terminal fuera de plazo para esta entrega. NULL = ninguno.';
COMMENT ON COLUMN deliveries.late_result_attempt IS
  'Intento al que pertenecía ese ACK tardío; puede ser menor que deliveries.attempt.';
COMMENT ON COLUMN deliveries.cancelled_at IS
  'Instante en que un operador canceló esta entrega (CauceRepository.cancelDelivery). Mientras no '
  'sea NULL ningún ACK terminal tardío puede rescatarla: el desenlace lo decidió una persona y el '
  'aviso al padre y al humano ya salió. Un replay no la limpia porque clona la entrega en una fila '
  'nueva, que nace con la columna en NULL.';
