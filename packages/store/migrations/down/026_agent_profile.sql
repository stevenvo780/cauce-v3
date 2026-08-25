-- Reversa de 026_agent_profile.sql
--
-- El runner (applyMigrations en packages/store/src/db.ts) NO lee este directorio: aplica en orden
-- alfabético los .sql de migrations/ e indexa por nombre de archivo. Esto se corre a mano.
--
-- ANTES DE CORRERLO: bajar la tabla casi nunca es lo que se quiere, porque `agents.role_brief`
-- SIGUE INTACTO — esta migración no lo tocó — y por lo tanto el sobre de la entrega sigue
-- llevando la identidad del alias esté esta tabla o no. Ningún agente se queda sin rol por vaciar
-- el perfil. Las salidas baratas, que no tocan el esquema:
--
--   -- dejar de generar el bloque para UN alias, conservando su fila:
--   UPDATE agent_profiles SET purpose=NULL, role_summary=NULL, responsibilities='{}',
--          restrictions='{}', tools='{}', operating_rules='{}', updated_at=now()
--    WHERE tenant_id='<tenant>' AND alias='<alias>';
--
--   -- apagar el perfil de TODA la flota sin migración ni rollback de imagen:
--   DELETE FROM agent_profiles;
--
-- Con el perfil vacío el compilador emite un bloque gestionado sin secciones, y lo que una persona
-- haya escrito a mano en CLAUDE.md o AGENTS.md fuera de las marcas se conserva byte a byte.
--
-- Bajar la tabla sólo tiene sentido si hay que retroceder la IMAGEN a una anterior a 026. Ojo:
-- esto BORRA todo lo autorado —propósito, responsabilidades, restricciones, herramientas y reglas—
-- y de la base no se recupera. Lo ÚNICO que sobrevive por su cuenta es `role_summary`, y sólo en
-- los alias donde todavía es la copia literal de `agents.role_brief`. Exportar primero:
--
--   \copy (SELECT tenant_id,alias,purpose,role_summary,responsibilities,restrictions,tools,operating_rules FROM agent_profiles) TO 'agent-profiles-backup.csv' CSV HEADER
--
-- EL ORDEN DE ABAJO NO ES ARBITRARIO, y la razón está MEDIDA (PostgreSQL 16.14, el 2026-08-24):
-- la base registra en `pg_depend` la dependencia entre un CHECK y la función que ese CHECK invoca,
-- así que un `DROP FUNCTION cauce_utf16_units(text)` corrido ANTES del `DROP TABLE` NO deja la
-- tabla envenenada: falla en el acto con
--
--   2BP01  cannot drop function cauce_utf16_units(text) because other objects depend on it
--
-- y el `IF EXISTS` no lo salva, porque sólo perdona que la función no exista, no que tenga
-- dependientes. O sea que este orden no depende de que quien lo corra se acuerde: la base se
-- niega. Primero la tabla, después las funciones; y `cauce_text_items_ok` invoca a
-- `cauce_utf16_units`, así que se baja antes que ella por la misma razón.
--
-- (La primera versión de este comentario afirmaba lo contrario —que Postgres NO registraba esa
-- dependencia— y era falso. Lo corrigió la prueba, no la relectura:
-- packages/store/test/agent-profile-migration-postgres.test.ts lo comprueba en cada corrida.)

BEGIN;

DROP TABLE IF EXISTS agent_profiles;

DROP FUNCTION IF EXISTS cauce_text_items_ok(text[], integer);
DROP FUNCTION IF EXISTS cauce_utf16_units(text);

DELETE FROM schema_migrations WHERE version='026_agent_profile.sql';

COMMIT;
