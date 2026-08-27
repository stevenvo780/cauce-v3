-- 015: Techo de concurrencia de entregas por agente y optimización de consultas en vuelo.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_concurrent_deliveries integer DEFAULT 2;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_max_concurrent_deliveries_sane'
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_max_concurrent_deliveries_sane
      CHECK (max_concurrent_deliveries IS NULL OR max_concurrent_deliveries BETWEEN 1 AND 100);
  END IF;
END
$$;

COMMENT ON COLUMN agents.max_concurrent_deliveries IS
  'Entregas no terminales (leased/accepted/started) que este agente puede tener a la vez por el '
  'CUPO GENERAL. claimDeliveries acota su límite general a max(0, esto - en_vuelo). La reserva '
  'humana del gateway es aditiva por encima de este techo. NULL = sin techo.';

CREATE INDEX IF NOT EXISTS deliveries_inflight_by_recipient_idx
  ON deliveries (recipient_tenant, recipient_alias)
  WHERE status IN ('leased', 'accepted', 'started');
