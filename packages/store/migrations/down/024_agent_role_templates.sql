-- Reversa de 024_agent_role_templates.sql
--
-- El runner (`applyMigrations` en packages/store/src/db.ts) NO lee este directorio: aplica en
-- orden alfabético los .sql de migrations/ e indexa por nombre de archivo. Esto se corre a mano.
--
-- ANTES DE CORRERLO: bajar el esquema casi nunca es lo que se quiere. Estas tres salidas baratas
-- no tocan el esquema y resuelven casi todo:
--
--   -- Una plantilla que no se quiere usar más, sin perder quién la llevó:
--   UPDATE agent_role_templates SET enabled=false, updated_at=now() WHERE slug='<slug>';
--
--   -- Desvincular un alias del catálogo dejándole su texto:
--   UPDATE agents SET role_template_slug=NULL, updated_at=now() WHERE tenant_id=$1 AND alias=$2;
--
--   -- Devolverle a un alias el rol que tenía antes (el diario guarda el texto exacto):
--   SELECT previous_brief FROM agent_role_brief_history
--    WHERE tenant_id=$1 AND alias=$2 ORDER BY id DESC LIMIT 1;
--
-- Bajar el esquema sólo tiene sentido para retroceder la IMAGEN a una anterior a la 024. Ojo con
-- lo que se lleva puesto, que NO se recupera desde la propia base:
--   * el catálogo entero de plantillas;
--   * el DIARIO entero de cambios de rol, que es la única copia del brief anterior de cada alias.
-- `agents.role_brief` NO se toca: cada alias conserva el texto que lleva puesto ahora mismo.
--
-- Exportá las dos cosas primero:
--   \copy (SELECT * FROM agent_role_templates) TO 'role-templates-backup.csv' CSV HEADER
--   \copy (SELECT * FROM agent_role_brief_history) TO 'role-brief-history-backup.csv' CSV HEADER

BEGIN;

-- Los triggers primero: si se dejaran vivos, el DROP COLUMN de abajo los dejaría apuntando a una
-- columna que ya no existe y el siguiente UPDATE de `agents` fallaría en producción.
DROP TRIGGER IF EXISTS agents_role_brief_journal ON agents;
DROP TRIGGER IF EXISTS agents_role_template_coherence ON agents;
DROP FUNCTION IF EXISTS cauce_agents_role_brief_journal();
DROP FUNCTION IF EXISTS cauce_agents_role_template_coherence();

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_role_template_fk;
DROP INDEX IF EXISTS agents_role_template_idx;
ALTER TABLE agents DROP COLUMN IF EXISTS role_template_slug;

DROP TABLE IF EXISTS agent_role_brief_history;
DROP TABLE IF EXISTS agent_role_templates;

DELETE FROM schema_migrations WHERE version='024_agent_role_templates.sql';

COMMIT;
