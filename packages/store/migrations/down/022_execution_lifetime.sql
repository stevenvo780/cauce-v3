-- Reversa de 022_execution_lifetime.sql
--
-- El runner (applyMigrations en packages/store/src/db.ts) NO lee este directorio: filtra por
-- `.sql` sobre migrations/, y `down` es un subdirectorio que readdir devuelve como 'down', sin
-- extensión. Este archivo se corre A MANO.
--
-- NO SE BAJA `execution_started_at`. Es la trampa de este rollback y por eso va primero: esa
-- columna PERTENECE A 012_execution_started_marker.sql, no a esta migración. 022 sólo la declara
-- con `ADD COLUMN IF NOT EXISTS` para que una base fresca de esta rama la tenga; en producción ya
-- existía (aplicada el 2026-07-27) y está POBLADA. Un `DROP COLUMN execution_started_at` acá se
-- llevaría datos de otra migración y dejaría al reaper sin la señal con la que decide si una garra
-- vencida ya se pagó — exactamente el bug que 012 vino a arreglar, y encima con el registro de 012
-- diciendo que sigue aplicada, así que el runner no la reaplicaría nunca.
--
-- ANTES DE CORRERLO: bajar el esquema casi nunca es lo que se quiere. Si el problema es que el
-- techo está matando trabajo que sí avanza, la salida barata no toca el esquema. El presupuesto
-- está CONGELADO POR FILA (se copia al crear la entrega, no se lee en caliente), así que subirlo
-- en las filas en vuelo desarma el techo sin desplegar y sin migrar:
--
--   UPDATE deliveries SET execution_lifetime_ms = 604800000
--    WHERE status IN ('leased','accepted','started');
--
-- Una semana en ms: el reaper deja de alcanzarlas y la columna (y este rollback) siguen en su
-- lugar. Cambiar CAUCE_EXECUTION_LIFETIME_MS NO sirve para eso: sólo afecta a las entregas que se
-- creen después.
--
-- ORDEN CONTRA EL CÓDIGO: al momento de integrar esta migración (2026-07-30) NINGÚN fichero de
-- main lee `execution_lifetime_ms` — la implementación del techo no está en main, sólo el esquema.
-- Por eso hoy este rollback se puede correr sin desplegar nada antes. Cuando la implementación
-- aterrice deja de ser cierto: habrá que desplegar PRIMERO el código que no proyecta la columna y
-- recién después correr esto, o entre el DROP y el redeploy cada claim del reaper falla con 42703
-- y el bus se queda mudo.
--
-- El COMENTARIO de `execution_started_at` no se revierte a propósito. 022 sólo lo escribe si
-- estaba vacío, y el texto que pone es LITERALMENTE el mismo que pone 012: borrarlo perdería la
-- documentación en la única superficie donde el operador la lee (\d+ deliveries) y no devolvería
-- nada, porque en producción ese comentario lo puso 012.
--
-- Orden interno: primero la constraint, después la columna. DROP COLUMN se llevaría la constraint
-- por dependencia, pero dejarlo explícito permite correr el archivo por partes si una de las dos
-- ya no está.
--
-- Todo en UNA transacción, incluido el borrado del registro. Media reversa aplicada es la forma
-- más cara de fallar: si la columna se va pero el registro sigue diciendo que la 022 está
-- aplicada, el runner no la reaplica jamás y ningún redeploy arregla la base. El DDL de PostgreSQL
-- es transaccional, así que la garantía es gratis.
BEGIN;

ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_execution_lifetime_ms_check;

ALTER TABLE deliveries DROP COLUMN IF EXISTS execution_lifetime_ms;

-- Sin esto el runner considera la migración aplicada para siempre y un re-deploy del árbol con la
-- 022 presente no la volvería a correr.
DELETE FROM schema_migrations WHERE version='022_execution_lifetime.sql';

COMMIT;
