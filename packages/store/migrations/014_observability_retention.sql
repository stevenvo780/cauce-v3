-- 014: Retención y discriminación de latidos vs transiciones de estado en tablas de observabilidad.

ALTER TABLE delivery_acks ADD COLUMN IF NOT EXISTS renewal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN delivery_acks.renewal IS
  'true = latido que sólo renovó la garra (retención corta). false = transición de estado o fila anterior a 014.';

CREATE INDEX IF NOT EXISTS delivery_acks_created_brin
  ON delivery_acks USING brin (created_at) WITH (pages_per_range = 32);
CREATE INDEX IF NOT EXISTS audit_events_created_brin
  ON audit_events USING brin (created_at) WITH (pages_per_range = 32);
