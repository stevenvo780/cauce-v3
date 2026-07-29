-- packages/store/migrations/018_terminal_recovery_backfill.sql
--
-- RESCATE DE LO QUE YA ESTÁ MUERTO. El código de este parche arregla el futuro: desde ahora todo
-- final de error escribe su fila en `dead_letters` y `replayDelivery` acepta 'failed' además de
-- 'dead'. Pero las entregas que YA murieron sin esa fila siguen siendo irrecuperables, porque el
-- botón de replay depende del JOIN con `dead_letters`. Esta migración las rescata.
--
-- MEDIDO EN PRODUCCIÓN el 2026-07-28 (base `cauce` de agora-storage, migraciones hasta la 013):
--
--   status  | entregas | con dead_letter
--   --------+----------+----------------
--   done    |    3.090 |      0   (correcto: no son error)
--   dead    |    2.028 |  1.806
--   failed  |      197 |      0   <-- el 100% irreplayable
--
-- O sea 419 entregas terminadas en error sin ninguna forma de rescate, y las dos poblaciones
-- tienen causas distintas:
--
--  (a) Las 197 'failed'. Nunca hubo INSERT para ellas: `ackDelivery` sólo lo hacía en la rama
--      'dead'. Y de qué lado caía cada entrega lo decidía `ack.retryable`, un booleano que manda
--      el agente que se acaba de romper. Sus motivos reales lo confirman: "OpenClaw result
--      contained a malformed JSON object" (32), "Structured output is missing 'reply'" (4),
--      "A failed harness output cannot delegate messages" (71). Fallas de FORMA, con el trabajo
--      probablemente hecho, condenadas para siempre por el propio proceso que falló.
--
--  (b) 221 de las 'dead' sin fila, todas con `last_error` que empieza con "cancelado por zeus
--      2026-07-28: ...". No las mató el sistema: las mató un humano con un UPDATE a mano en psql,
--      porque no existía ninguna operación de cancelación (`adapter-sdk/src/sdk/types.ts` dice
--      textual "V3 has no remote cancel frame"). Ese camino saltea las tres cosas que ahora hace
--      `cancelDelivery`, y ésta es la primera: dejar rastro replayable.
--
-- La 018 le da a las 419 exactamente lo que les falta y nada más: la fila abierta en
-- `dead_letters`. No toca `deliveries`, no cambia ningún estado, no reencola nada. Después de
-- aplicarla el operador ve el botón de replay y decide una por una; ninguna se reintenta sola.
--
-- POR QUÉ 018 Y NO 014..017: cuando se escribió convivían en el árbol de integración dos
-- migraciones numeradas 014 (`014_failure_notice_coalescing.sql` y `014_observability_retention.sql`)
-- y había otros parches en vuelo que agregaban más. El runner indexa por NOMBRE de archivo y ordena
-- por nombre, así que el número sólo define el ORDEN. Esta migración no depende de ninguna otra
-- —sólo de tablas de la 001— así que puede correr en cualquier posición; el 018 es para no
-- colisionar. Ver NOTAS.md.
--
-- La colisión de las dos 014 quedó resuelta en la consolidación del 2026-07-29: la de coalescencia
-- pasó a `021_failure_notice_coalescing.sql`, y la serie es 001..021 sin huecos ni repetidos.
--
-- IDEMPOTENTE de verdad, en los dos sentidos que importan:
--   * `ON CONFLICT (delivery_id) DO NOTHING` sobre el UNIQUE de `dead_letters.delivery_id`, más
--     el `NOT EXISTS` implícito del LEFT JOIN: correrla dos veces no duplica ni una fila.
--   * La condición mira el ESTADO ACTUAL de la base, no una marca de "ya migré", así que si el
--     runner la reaplica sobre una base que ya la tiene, inserta cero filas y no audita nada.
--
-- NO ES DDL: no hay ALTER, no hay CREATE de tabla y por lo tanto no hay riesgo de que el gateway
-- y el dispatcher no arranquen por culpa de este archivo. El peor caso es insertar 419 filas.

WITH backfilled AS (
  INSERT INTO dead_letters (delivery_id, tenant_id, reason, payload, attempts, created_at)
  SELECT delivery.id,
         delivery.recipient_tenant,
         -- `reason` es NOT NULL. Se prefiere el error real de la entrega; el prefijo dice de dónde
         -- salió la fila, para que nadie confunda un rescate retroactivo con un dead letter que el
         -- sistema escribió en su momento.
         'backfill 018 (' || delivery.status || '): '
           || COALESCE(NULLIF(btrim(delivery.last_error), ''), 'terminal error without recorded text'),
         message.body,
         delivery.attempt,
         -- `created_at` es el instante en que la entrega MURIÓ, no el de la migración. Con el
         -- default `now()`, 419 dead letters de días distintos nacerían todas en el mismo segundo
         -- y la consola —que ordena por `created_at`— mostraría lo más viejo encima de lo más
         -- nuevo. `updated_at` es el respaldo para las filas que un UPDATE manual dejó sin
         -- `terminal_at`, que son justamente las 221 canceladas a mano.
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
-- Deja constancia de cuántas se rescataron. No es decorativo: sin esto no hay forma de contestar
-- después "¿estas 419 dead letters aparecieron por un incidente o por la migración?", y esa
-- pregunta se hace justo cuando el panel se pone rojo. `HAVING` evita escribir la fila cuando no
-- hubo nada que rescatar, que es el caso de toda base nueva y de toda reaplicación.
INSERT INTO audit_events (tenant_id, actor_alias, action, decision, metadata)
SELECT NULL, NULL, 'migration.dead_letter_backfill', 'info',
       jsonb_build_object(
         'migration', '018_terminal_recovery_backfill',
         'rescued', COALESCE(sum(rescued), 0),
         'by_status', COALESCE(jsonb_object_agg(status, rescued), '{}'::jsonb)
       )
FROM summary
HAVING COALESCE(sum(rescued), 0) > 0;
