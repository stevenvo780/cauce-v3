-- Marca durable de "el harness EMPEZÓ a ejecutar", distinta de "la entrega fue admitida".
--
-- El reaper necesitaba decidir si una garra vencida ya se había pagado. Venía usando la
-- presencia de un ACK 'started', y eso es FALSO: packages/adapter-sdk emite 'started' antes de
-- llamar al harness, y la entrega puede quedarse minutos esperando el candado de sesión sin
-- haber ejecutado nada. Con esa señal el reaper mandaba a dead trabajo que jamás corrió.
--
-- Es una columna y no una fila en delivery_acks porque el reaper la lee en su SELECT ... FOR
-- UPDATE de cada tick: como columna es un test sobre la fila que ya tiene bajo lock, sin
-- subconsulta y sin riesgo de acercarse a la combinación FOR UPDATE + función de ventana que
-- PostgreSQL rechaza al parsear y que ya tumbó producción una vez.
--
-- Se limpia en cada reintento (ver `ackDelivery` y `retryStaleDeliveries`): pertenece al intento
-- vigente, no a la entrega. Un intento nuevo todavía no ejecutó nada.
--
-- NULL en todas las filas existentes es la respuesta correcta para el histórico: de una entrega
-- vieja no sabemos si llegó a ejecutar, y "no sé" tiene que caer del lado que reintenta (caro)
-- y no del lado que descarta (pérdida de trabajo).
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;

COMMENT ON COLUMN deliveries.execution_started_at IS
  'Instante del primer ACK con execution_started=true del intento vigente. NULL = no consta que el harness haya arrancado.';
