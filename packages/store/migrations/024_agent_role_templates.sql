-- Plantillas de rol reutilizables y diario de asignaciones por alias.
-- Clave global (no por tenant) para permitir roles compartidos entre tenants.
-- brief CHECK <= 1200 puntos de código (char_length), alineado con agents.role_brief.

CREATE TABLE IF NOT EXISTS agent_role_templates (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_-]{0,63}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  brief text NOT NULL CHECK (char_length(brief) BETWEEN 1 AND 1200),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Asignación de plantilla de rol por alias (FK nullable hacia agent_role_templates ON DELETE SET NULL).
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS role_template_slug text;

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_role_template_fk;
ALTER TABLE agents
  ADD CONSTRAINT agents_role_template_fk
  FOREIGN KEY (role_template_slug) REFERENCES agent_role_templates(slug) ON DELETE SET NULL
  NOT VALID;

-- Índice para búsqueda de alias por plantilla y soporte de cascada FK.
CREATE INDEX IF NOT EXISTS agents_role_template_idx
  ON agents (role_template_slug) WHERE role_template_slug IS NOT NULL;

-- Diario histórico de cambios de role_brief y asignaciones de plantilla por alias.
CREATE TABLE IF NOT EXISTS agent_role_brief_history (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  alias text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('insert','update','delete')),
  previous_brief text,
  previous_template_slug text,
  new_brief text,
  new_template_slug text,
  -- Actor opcional proveniente de variables de sesión (cauce.actor_*).
  actor_tenant text,
  actor_alias text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_role_brief_history_alias_idx
  ON agent_role_brief_history (tenant_id, alias, id DESC);

-- Trigger BEFORE para mantener la coherencia entre role_template_slug y role_brief.
-- Si el rol difiere del texto de la plantilla, se desvincula la plantilla (role_template_slug = NULL).
CREATE OR REPLACE FUNCTION cauce_agents_role_template_coherence() RETURNS trigger AS $$
DECLARE
  brief_de_la_plantilla text;
BEGIN
  IF NEW.role_template_slug IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT brief INTO brief_de_la_plantilla
    FROM agent_role_templates WHERE slug = NEW.role_template_slug;
  IF brief_de_la_plantilla IS NULL OR NEW.role_brief IS DISTINCT FROM brief_de_la_plantilla THEN
    NEW.role_template_slug := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_role_template_coherence ON agents;
CREATE TRIGGER agents_role_template_coherence
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION cauce_agents_role_template_coherence();

-- Trigger AFTER para registrar en agent_role_brief_history cualquier cambio de role_brief o plantilla.
CREATE OR REPLACE FUNCTION cauce_agents_role_brief_journal() RETURNS trigger AS $$
DECLARE
  brief_anterior text := NULL;
  slug_anterior text := NULL;
  brief_nuevo text := NULL;
  slug_nuevo text := NULL;
  id_tenant text;
  id_alias text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    brief_anterior := OLD.role_brief;
    slug_anterior := OLD.role_template_slug;
    id_tenant := OLD.tenant_id;
    id_alias := OLD.alias;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    brief_nuevo := NEW.role_brief;
    slug_nuevo := NEW.role_template_slug;
    id_tenant := NEW.tenant_id;
    id_alias := NEW.alias;
  END IF;
  IF brief_anterior IS NOT DISTINCT FROM brief_nuevo
     AND slug_anterior IS NOT DISTINCT FROM slug_nuevo THEN
    RETURN NULL;
  END IF;
  INSERT INTO agent_role_brief_history(
    tenant_id, alias, operation, previous_brief, previous_template_slug,
    new_brief, new_template_slug, actor_tenant, actor_alias
  ) VALUES (
    id_tenant, id_alias, lower(TG_OP), brief_anterior, slug_anterior,
    brief_nuevo, slug_nuevo,
    NULLIF(current_setting('cauce.actor_tenant', true), ''),
    NULLIF(current_setting('cauce.actor_alias', true), '')
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_role_brief_journal ON agents;
CREATE TRIGGER agents_role_brief_journal
  AFTER INSERT OR UPDATE OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION cauce_agents_role_brief_journal();
