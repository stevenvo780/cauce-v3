-- 018: Backfill de registros en dead_letters para entregas históricas en estado failed o dead sin fila asociada.

WITH backfilled AS (
  INSERT INTO dead_letters (delivery_id, tenant_id, reason, payload, attempts, created_at)
  SELECT delivery.id,
         delivery.recipient_tenant,
         -- Prefijo identificador para filas creadas por este backfill.
         'backfill 018 (' || delivery.status || '): '
           || COALESCE(NULLIF(btrim(delivery.last_error), ''), 'terminal error without recorded text'),
         message.body,
         delivery.attempt,
         -- Preserva la marca temporal original de la entrega terminada.
         COALESCE(delivery.terminal_at, delivery.updated_at, delivery.created_at)
  FROM deliveries delivery
  JOIN messages message ON message.id = delivery.message_id
  LEFT JOIN dead_letters existing ON existing.delivery_id = delivery.id
  WHERE delivery.status IN ('failed', 'dead')
    AND existing.id IS NULL
  ON CONFLICT (delivery_id) DO NOTHING
  RETURNING delivery_id
),
summary AS (
  SELECT delivery.status AS status, count(*) AS rescued
  FROM backfilled
  JOIN deliveries delivery ON delivery.id = backfilled.delivery_id
  GROUP BY delivery.status
)
-- Registra evento de auditoría si se insertaron filas en el backfill.
INSERT INTO audit_events (tenant_id, actor_alias, action, decision, metadata)
SELECT NULL, NULL, 'migration.dead_letter_backfill', 'info',
       jsonb_build_object(
         'migration', '018_terminal_recovery_backfill',
         'rescued', COALESCE(sum(rescued), 0),
         'by_status', COALESCE(jsonb_object_agg(status, rescued), '{}'::jsonb)
       )
FROM summary
HAVING COALESCE(sum(rescued), 0) > 0;
