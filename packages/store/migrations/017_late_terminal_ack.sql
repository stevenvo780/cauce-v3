-- 017: Columnas de rescate de ACKs terminales tardíos y marca de cancelación en deliveries.

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
