-- Reversa de 015_delivery_concurrency_cap.sql
--
-- El runner (packages/store/src/db.ts, applyMigrations) sólo lee `*.sql` del directorio
-- `migrations/`; `down/` es un subdirectorio y readdir lo devuelve como 'down', que no termina
-- en .sql y queda filtrado. Este archivo nunca se aplica solo: es para ejecutarlo a mano.
--
-- Revertir la COLUMNA no es urgente ni riesgoso: el código que la lee usa COALESCE contra la
-- ausencia de fila, así que quitarla sólo devuelve a "sin techo". Si lo que hace falta es
-- desactivar el techo YA y sin desplegar, no corras esto — corré:
--
--   UPDATE agents SET max_concurrent_deliveries = NULL;
--
-- que apaga el límite dejando la columna (y el rollback real) en su lugar.
--
-- Orden: primero el índice, después la constraint, después la columna. DROP COLUMN se llevaría la
-- constraint por dependencia, pero dejarlo explícito hace que este archivo se pueda correr por
-- partes si una de las tres ya no está.
--
-- Todo en UNA transacción: si el DROP de la columna falla, el índice y la constraint tienen que
-- volver, y sobre todo el registro no puede quedar borrado con el esquema a medio bajar (ni al
-- revés). El DDL de PostgreSQL es transaccional, así que la garantía es gratis.
BEGIN;

DROP INDEX IF EXISTS deliveries_inflight_by_recipient_idx;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_max_concurrent_deliveries_sane;

ALTER TABLE agents DROP COLUMN IF EXISTS max_concurrent_deliveries;

-- Sin esto el runner considera la migración aplicada para siempre y un re-deploy del árbol con
-- la 015 presente no la volvería a correr.
DELETE FROM schema_migrations WHERE version = '015_delivery_concurrency_cap.sql';

COMMIT;
