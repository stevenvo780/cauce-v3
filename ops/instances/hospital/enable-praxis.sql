\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE agent_role_templates, agents, agent_profiles, deliveries
  IN SHARE ROW EXCLUSIVE MODE;

DO $praxis$
DECLARE
  base_developer_brief text;
  praxis_developer_brief text;
  operator_purpose constant text := 'Coordinar Praxis como repositorio separado del CRM con datos sintéticos, integrando cambios revisados de Teseo y Perseo sin implementar código.';
  operator_responsibility constant text := 'Coordinar el desarrollo de Praxis como repositorio separado del CRM: una incidencia terminable por entrega, con Teseo y Perseo trabajando en clones aislados.';
  obsolete_operator_restriction constant text := 'No usar hospital_ops ni el despliegue del CRM para Praxis; no mezclar código o datos de ambos proyectos ni presentar pruebas técnicas como aprobación clínica.';
  operator_restriction constant text := 'Para Praxis no usar acciones de candidato/release CRM de hospital_ops; sí usar vps_authorization, vps_exec y vps_job_status para Git e integración con reversa. No mezclar código o datos entre proyectos ni presentar pruebas técnicas como aprobación clínica.';
  operator_tool constant text := 'skill local: praxis-workflow';
  operator_rule constant text := 'Praxis se desarrolla y prueba con datos sintéticos en un repositorio independiente; el operador revisa e integra resultados sin programar.';
  developer_purpose constant text := 'Desarrollar el repositorio Praxis, separado del CRM, en un clon aislado con datos sintéticos y una incidencia por turno.';
  developer_responsibility constant text := 'Desarrollar Praxis sólo en el clon aislado de este alias: resolver una incidencia concreta por turno con datos sintéticos y entregar commits y pruebas reproducibles al operador.';
  developer_restriction constant text := 'No mezclar código, historiales, secretos ni datos entre Praxis y el CRM; no usar pacientes reales, hospital_ops ni el despliegue del CRM para Praxis.';
  developer_tool constant text := 'Repositorio Praxis: clon aislado de este alias, edición y pruebas locales';
  developer_rule constant text := 'Cerrar cada incidencia de Praxis con evidencia; una prueba técnica no constituye aprobación clínica.';
BEGIN
  SELECT brief INTO base_developer_brief
    FROM agent_role_templates
   WHERE slug = 'hospital-developer' AND enabled;

  IF base_developer_brief IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM agent_role_templates
        WHERE slug = 'hospital-lider' AND enabled
     )
  THEN
    RAISE EXCEPTION 'Praxis requires the enabled Hospital role templates';
  END IF;

  praxis_developer_brief := base_developer_brief
    || ' También desarrollás Praxis en un clon aislado del repositorio separado del CRM, con datos sintéticos y una incidencia por turno; entregás commits y pruebas al operador. Nunca uses pacientes reales ni declares aprobación clínica.';

  IF char_length(praxis_developer_brief) > 1200 THEN
    RAISE EXCEPTION 'Praxis developer role exceeds the 1200-character template limit';
  END IF;

  IF (SELECT array_agg(alias || ':' || harness_id || ':' || container_name ORDER BY alias)
        FROM agents WHERE tenant_id = 'Hospital' AND enabled)
     IS DISTINCT FROM ARRAY[
       'operador:openclaw:hospital-agent-openclaw-operator-gateway-1',
       'perseo:muse:hospital-agent-muse-frontend-1',
       'teseo:muse:hospital-agent-muse-backend-1'
     ]::text[]
     OR (SELECT count(*)
           FROM agent_profiles profile JOIN agents agent USING (tenant_id, alias)
          WHERE agent.tenant_id = 'Hospital' AND agent.enabled) <> 3
     OR EXISTS (
       SELECT 1 FROM deliveries
        WHERE recipient_tenant = 'Hospital'
          AND recipient_alias IN ('operador', 'teseo', 'perseo')
          AND status IN ('leased', 'accepted', 'started')
     )
  THEN
    RAISE EXCEPTION 'Praxis requires the exact three-agent Hospital runtime and zero inflight deliveries';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agents
     WHERE role_template_slug = 'hospital-praxis-developer'
       AND (tenant_id, alias) NOT IN (('Hospital', 'teseo'), ('Hospital', 'perseo'))
  ) OR EXISTS (
    SELECT 1 FROM agent_role_templates
     WHERE slug = 'hospital-praxis-developer'
       AND (brief IS DISTINCT FROM praxis_developer_brief OR NOT enabled)
  ) THEN
    RAISE EXCEPTION 'Praxis developer template is shared or has drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM agents agent JOIN agent_profiles profile USING (tenant_id, alias)
      JOIN agent_role_templates template ON template.slug = agent.role_template_slug
     WHERE agent.tenant_id = 'Hospital' AND agent.alias = 'operador'
       AND agent.enabled AND agent.role_template_slug = 'hospital-lider'
       AND agent.role_brief = template.brief
       AND profile.role_summary = template.brief
  ) OR EXISTS (
    SELECT 1 FROM agents agent JOIN agent_profiles profile USING (tenant_id, alias)
     WHERE agent.tenant_id = 'Hospital' AND agent.alias IN ('teseo', 'perseo')
       AND ((
         (agent.role_template_slug = 'hospital-developer'
          AND agent.role_brief = base_developer_brief
          AND profile.role_summary = base_developer_brief)
         OR (agent.role_template_slug = 'hospital-praxis-developer'
             AND agent.role_brief = praxis_developer_brief
             AND profile.role_summary = praxis_developer_brief)
       ) IS NOT TRUE)
  ) THEN
    RAISE EXCEPTION 'Praxis refuses non-canonical Hospital role or profile drift';
  END IF;

  INSERT INTO agent_role_templates(slug, display_name, brief, enabled)
  VALUES ('hospital-praxis-developer', 'Developer Hospital y Praxis',
          praxis_developer_brief, true)
  ON CONFLICT (slug) DO NOTHING;

  UPDATE agents
     SET role_template_slug = 'hospital-praxis-developer',
         role_brief = praxis_developer_brief,
         updated_at = now()
   WHERE tenant_id = 'Hospital' AND alias IN ('teseo', 'perseo')
     AND role_template_slug = 'hospital-developer';

  UPDATE agent_profiles
     SET purpose = CASE
           WHEN position(operator_purpose in coalesce(purpose, '')) > 0 THEN purpose
           WHEN purpose IS NULL THEN operator_purpose
           ELSE purpose || ' ' || operator_purpose END,
         responsibilities = CASE
           WHEN operator_responsibility = ANY(responsibilities) THEN responsibilities
           ELSE array_append(responsibilities, operator_responsibility) END,
         restrictions = CASE
           WHEN obsolete_operator_restriction = ANY(restrictions)
             AND operator_restriction = ANY(restrictions)
             THEN array_remove(restrictions, obsolete_operator_restriction)
           WHEN obsolete_operator_restriction = ANY(restrictions)
             THEN array_replace(restrictions, obsolete_operator_restriction, operator_restriction)
           WHEN operator_restriction = ANY(restrictions) THEN restrictions
           ELSE array_append(restrictions, operator_restriction) END,
         tools = CASE
           WHEN operator_tool = ANY(tools) THEN tools
           ELSE array_append(tools, operator_tool) END,
         operating_rules = CASE
           WHEN operator_rule = ANY(operating_rules) THEN operating_rules
           ELSE array_append(operating_rules, operator_rule) END,
         updated_at = now()
   WHERE tenant_id = 'Hospital' AND alias = 'operador'
     AND (position(operator_purpose in coalesce(purpose, '')) = 0
       OR NOT operator_responsibility = ANY(responsibilities)
       OR NOT operator_restriction = ANY(restrictions)
       OR obsolete_operator_restriction = ANY(restrictions)
       OR NOT operator_tool = ANY(tools)
       OR NOT operator_rule = ANY(operating_rules));

  UPDATE agent_profiles
     SET purpose = CASE
           WHEN position(developer_purpose in coalesce(purpose, '')) > 0 THEN purpose
           WHEN purpose IS NULL THEN developer_purpose
           ELSE purpose || ' ' || developer_purpose END,
         responsibilities = CASE
           WHEN developer_responsibility = ANY(responsibilities) THEN responsibilities
           ELSE array_append(responsibilities, developer_responsibility) END,
         restrictions = CASE
           WHEN developer_restriction = ANY(restrictions) THEN restrictions
           ELSE array_append(restrictions, developer_restriction) END,
         tools = CASE
           WHEN developer_tool = ANY(tools) THEN tools
           ELSE array_append(tools, developer_tool) END,
         operating_rules = CASE
           WHEN developer_rule = ANY(operating_rules) THEN operating_rules
           ELSE array_append(operating_rules, developer_rule) END,
         updated_at = now()
   WHERE tenant_id = 'Hospital' AND alias IN ('teseo', 'perseo')
     AND (position(developer_purpose in coalesce(purpose, '')) = 0
       OR NOT developer_responsibility = ANY(responsibilities)
       OR NOT developer_restriction = ANY(restrictions)
       OR NOT developer_tool = ANY(tools)
       OR NOT developer_rule = ANY(operating_rules));

  IF (SELECT count(*)
        FROM agents agent JOIN agent_profiles profile USING (tenant_id, alias)
       WHERE agent.tenant_id = 'Hospital' AND agent.alias IN ('teseo', 'perseo')
         AND agent.enabled AND agent.role_template_slug = 'hospital-praxis-developer'
         AND agent.role_brief = praxis_developer_brief
         AND profile.role_summary = praxis_developer_brief
         AND position(developer_purpose in profile.purpose) > 0
         AND developer_responsibility = ANY(profile.responsibilities)
         AND developer_restriction = ANY(profile.restrictions)
         AND developer_tool = ANY(profile.tools)
         AND developer_rule = ANY(profile.operating_rules)) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM agent_profiles
        WHERE tenant_id = 'Hospital' AND alias = 'operador'
          AND position(operator_purpose in purpose) > 0
          AND operator_responsibility = ANY(responsibilities)
          AND operator_restriction = ANY(restrictions)
          AND NOT obsolete_operator_restriction = ANY(restrictions)
          AND operator_tool = ANY(tools)
          AND operator_rule = ANY(operating_rules)
     )
  THEN
    RAISE EXCEPTION 'Praxis profile verification failed';
  END IF;
END
$praxis$;

COMMIT;

SELECT agent.alias, agent.role_template_slug, profile.revision AS desired_revision,
       profile.applied_revision,
       CASE WHEN profile.applied_revision = profile.revision
         THEN 'acknowledged' ELSE 'pending_runtime_apply' END AS runtime_apply_state,
       agent.role_brief = profile.role_summary AS canonical_role_matches
  FROM agents agent JOIN agent_profiles profile USING (tenant_id, alias)
 WHERE agent.tenant_id = 'Hospital' AND agent.enabled
 ORDER BY agent.alias;
