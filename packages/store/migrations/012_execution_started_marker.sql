-- Marca durable de inicio real de ejecución en deliveries (execution_started_at).
-- Distingue la admisión de la entrega del inicio efectivo de ejecución por parte del harness.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;

COMMENT ON COLUMN deliveries.execution_started_at IS
  'Instante del primer ACK con execution_started=true del intento vigente. NULL = no consta que el harness haya arrancado.';
