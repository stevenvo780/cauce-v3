-- Retira el plano de traspaso sellado.
--
-- No lleva la compuerta «después de que haya evidencia» que sí llevan 035 y 037, y la diferencia
-- es qué guarda cada tabla. Aquellas guardan PRUEBA de lo que pasó y borrarla sería perder el
-- registro. `secret_handoffs` guarda estado efímero: nada vive más de 24 h y todo se lee una sola
-- vez, así que tirar las tablas destruye traspasos en vuelo —el emisor los vuelve a sellar— y no
-- destruye ninguna prueba: la auditoría de `secret.granted` / `secret.read` / `secret.revoked`
-- vive en `audit_events` y esta migración no la toca.
--
-- Como en todo el juego, el rollback de verdad de la base es el backup; esto existe para que el
-- juego de migraciones tenga inversa probada.

SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_039);

-- Orden de dependencia: primero la tabla que referencia agentes por dos lados, después las claves.
-- Ninguna de las dos es referenciada por nada, así que no hace falta CASCADE.
DROP TABLE IF EXISTS secret_handoffs;
DROP TABLE IF EXISTS agent_sealing_keys;

DELETE FROM schema_migrations WHERE version='039_secret_handoff.sql';
