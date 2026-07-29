-- Reversa de 020_agent_role_brief.sql
--
-- El runner (applyMigrations en packages/store/src/db.ts) NO lee este directorio: aplica en orden
-- alfabético los .sql de migrations/ e indexa por nombre de archivo. Esto se corre a mano.
--
-- ANTES DE CORRERLO: bajar el esquema casi nunca es lo que se quiere. Si el problema es que un
-- role_brief está mal escrito o le pisa el rol a alguien, la salida barata es una sentencia y no
-- toca el esquema:
--
--   UPDATE agents SET role_brief=NULL, updated_at=now() WHERE alias='<alias>';
--
-- Con role_brief NULL el adaptador emite el preámbulo SIN la línea `Tu rol:` — el agente sigue
-- sabiendo quién es y cómo funciona Cauce, y deja de recibir el rol equivocado. Para apagar el
-- preámbulo ENTERO sin migración ni rollback de imagen, vaciar la columna en toda la tabla:
--
--   UPDATE agents SET role_brief=NULL, updated_at=now();
--
-- Bajar la columna sólo tiene sentido si hay que retroceder la IMAGEN a una anterior a 020. Ojo:
-- esto BORRA los 15 textos de rol y no hay forma de recuperarlos desde la propia base. Exportarlos
-- primero:
--
--   \copy (SELECT tenant_id,alias,role_brief FROM agents WHERE role_brief IS NOT NULL) TO 'role_briefs-backup.csv' CSV HEADER

BEGIN;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_role_brief_len;
ALTER TABLE agents DROP COLUMN IF EXISTS role_brief;

DELETE FROM schema_migrations WHERE version='020_agent_role_brief.sql';

COMMIT;
