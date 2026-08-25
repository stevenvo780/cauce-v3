-- Reversa de 028_canonical_agent_role.sql.
--
-- Es una retirada COMPATIBLE, no una pérdida de identidad. Antes de quitar la sincronización se
-- vuelve a materializar en `agents.role_brief` la proyección de cada perfil. Una imagen anterior
-- puede volver a leer esa columna inmediatamente. El perfil rico permanece intacto; bajar después
-- la 026 sigue requiriendo el export documentado en down/026_agent_profile.sql.
--
-- Mientras esta reversa corre nadie debe editar perfiles: igual que toda migración de esquema, el
-- runner debe poseer el lock de migraciones y los escritores de configuración deben estar fuera.

BEGIN;

-- El forward runner usa esta misma llave para serializar schema_migrations e integridad. El down
-- manual debe entrar en esa misma exclusión antes de apagar triggers o proyectar datos.
SELECT pg_advisory_xact_lock(783_003_003);

-- Primero se apagan los escritores cruzados. Si se proyectara mientras el trigger legacy sigue
-- vivo, un perfil rico de más de 1.200 caracteres recibiría de vuelta su propia proyección
-- truncada y el down destruiría precisamente el dato que promete conservar.
DROP TRIGGER IF EXISTS agent_role_templates_propagate_profile ON agent_role_templates;
DROP TRIGGER IF EXISTS agents_translate_legacy_role ON agents;
DROP TRIGGER IF EXISTS agent_profiles_project_role ON agent_profiles;
DROP TRIGGER IF EXISTS agent_profiles_manage_revision ON agent_profiles;

UPDATE agents agent
   SET role_brief=cauce_role_summary_to_brief(profile.role_summary),
       role_template_slug=CASE
         WHEN EXISTS (
           SELECT 1 FROM agent_role_templates template
            WHERE template.slug=agent.role_template_slug
              AND template.brief=profile.role_summary
         ) THEN agent.role_template_slug
         ELSE NULL
       END,
       updated_at=now()
  FROM agent_profiles profile
 WHERE profile.tenant_id=agent.tenant_id AND profile.alias=agent.alias
   AND (
     agent.role_brief IS DISTINCT FROM cauce_role_summary_to_brief(profile.role_summary)
     OR agent.role_template_slug IS DISTINCT FROM CASE
       WHEN EXISTS (
         SELECT 1 FROM agent_role_templates template
          WHERE template.slug=agent.role_template_slug
            AND template.brief=profile.role_summary
       ) THEN agent.role_template_slug
       ELSE NULL
     END
   );

DROP FUNCTION IF EXISTS cauce_sync_role_template_to_profiles();

DROP FUNCTION IF EXISTS cauce_sync_agent_role_to_profile();

DROP FUNCTION IF EXISTS cauce_sync_profile_role_to_agent();

DROP FUNCTION IF EXISTS cauce_agent_profile_revision_guard();

ALTER TABLE agent_profiles
  DROP CONSTRAINT IF EXISTS agent_profiles_role_summary_visible;

ALTER TABLE agent_profiles
  DROP CONSTRAINT IF EXISTS agent_profiles_applied_revision_valid,
  DROP CONSTRAINT IF EXISTS agent_profiles_revision_positive,
  DROP COLUMN IF EXISTS applied_revision,
  DROP COLUMN IF EXISTS revision;

DROP FUNCTION IF EXISTS cauce_role_summary_to_brief(text);

DELETE FROM schema_migrations WHERE version='028_canonical_agent_role.sql';

COMMIT;
