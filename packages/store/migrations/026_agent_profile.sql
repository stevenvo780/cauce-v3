-- Perfiles de configuración y contexto por alias (agent_profiles).
-- Fuente de verdad para identidad, rol, responsabilidades, restricciones, herramientas y reglas operativas.

-- Calcula la longitud en unidades de código UTF-16 (compatible con String.length de JavaScript).
CREATE OR REPLACE FUNCTION cauce_utf16_units(t text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN t IS NULL THEN 0 ELSE
      char_length(t) + (char_length(t) - char_length(regexp_replace(t, '[\U00010000-\U0010FFFF]', '', 'g')))
    END
  $$;

-- Valida que cada elemento no esté vacío y no supere max_units en UTF-16.
CREATE OR REPLACE FUNCTION cauce_text_items_ok(items text[], max_units integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT NOT EXISTS (
      SELECT 1 FROM unnest(coalesce(items, '{}'::text[])) AS item
      WHERE item !~ '\S' OR cauce_utf16_units(item) > max_units
    )
  $$;

-- Tabla principal de perfiles de agente por (tenant_id, alias).
CREATE TABLE IF NOT EXISTS agent_profiles (
  tenant_id text NOT NULL,
  alias text NOT NULL,

  -- Identidad y propósito del agente.
  purpose text,

  -- Resumen de rol, responsabilidades y restricciones declaradas.
  role_summary text,
  responsibilities text[] NOT NULL DEFAULT '{}',
  restrictions text[] NOT NULL DEFAULT '{}',

  -- Breve descripción del usuario humano asociado.
  human_brief text,

  -- Herramientas y capacidades específicas autorizadas.
  tools text[] NOT NULL DEFAULT '{}',

  -- Instrucciones fijas de funcionamiento del alias.
  operating_rules text[] NOT NULL DEFAULT '{}',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, alias),
  FOREIGN KEY (tenant_id, alias) REFERENCES agents(tenant_id, alias) ON DELETE CASCADE,

  -- Límites de longitud por campo en unidades UTF-16.
  CONSTRAINT agent_profiles_purpose_len CHECK (
    purpose IS NULL OR cauce_utf16_units(purpose) BETWEEN 1 AND 2000
  ),
  CONSTRAINT agent_profiles_role_summary_len CHECK (
    role_summary IS NULL OR cauce_utf16_units(role_summary) BETWEEN 1 AND 4000
  ),
  CONSTRAINT agent_profiles_human_brief_len CHECK (
    human_brief IS NULL OR cauce_utf16_units(human_brief) BETWEEN 1 AND 2000
  ),

  -- Cardinalidad máxima y longitud individual para arrays de texto.
  CONSTRAINT agent_profiles_responsibilities_count CHECK (coalesce(array_length(responsibilities,1),0) <= 64),
  CONSTRAINT agent_profiles_responsibilities_items CHECK (cauce_text_items_ok(responsibilities, 1000)),
  CONSTRAINT agent_profiles_restrictions_count CHECK (coalesce(array_length(restrictions,1),0) <= 64),
  CONSTRAINT agent_profiles_restrictions_items CHECK (cauce_text_items_ok(restrictions, 1000)),
  CONSTRAINT agent_profiles_tools_count CHECK (coalesce(array_length(tools,1),0) <= 64),
  CONSTRAINT agent_profiles_tools_items CHECK (cauce_text_items_ok(tools, 1000)),
  CONSTRAINT agent_profiles_operating_rules_count CHECK (coalesce(array_length(operating_rules,1),0) <= 64),
  CONSTRAINT agent_profiles_operating_rules_items CHECK (cauce_text_items_ok(operating_rules, 1000)),

  -- Presupuesto acumulado máximo de unidades UTF-16 para el perfil compilado (<= 24000).
  CONSTRAINT agent_profiles_budget CHECK (
    cauce_utf16_units(coalesce(purpose,''))
    + cauce_utf16_units(coalesce(role_summary,''))
    + cauce_utf16_units(coalesce(human_brief,''))
    + cauce_utf16_units(array_to_string(responsibilities,''))
    + cauce_utf16_units(array_to_string(restrictions,''))
    + cauce_utf16_units(array_to_string(tools,''))
    + cauce_utf16_units(array_to_string(operating_rules,''))
    <= 24000
  )
);

-- Siembra inicial de role_summary a partir de agents.role_brief existente.
INSERT INTO agent_profiles (tenant_id, alias, role_summary)
SELECT tenant_id, alias, btrim(role_brief)
  FROM agents
 WHERE role_brief IS NOT NULL AND btrim(role_brief) <> ''
ON CONFLICT (tenant_id, alias) DO NOTHING;
