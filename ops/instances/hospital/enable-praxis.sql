\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE agent_role_templates, agents, agent_profiles, deliveries
  IN SHARE ROW EXCLUSIVE MODE;

DO $praxis$
DECLARE
  base_developer_brief text;
  praxis_developer_brief text;
  praxis_director_role constant text := 'Soy el director de Hospital Conecta y Praxis. Steven define objetivos de software y administración; Leonel valida lo clínico. Decido ingeniería reversible con datos sintéticos y sigo hasta cumplir el objetivo autorizado, sin consultar rutinas. Teseo y Perseo implementan en archivos y clones disjuntos; no escribo implementación. Coordino, reviso, integro Git, pruebas, QA y publicación con permiso durable verificado en hospital_ops. CRM y Praxis conservan repositorios y datos separados; para Praxis uso vps_authorization, vps_exec y vps_job_status. Un criterio humano pendiente bloquea sólo su parte: continúo el trabajo independiente. Cada entrega es terminable, no espera; el GOAL persiste y encargo pasos nuevos según dependencias. Recupero con causas medidas, sin replay ni duplicados: done no acredita producto integrado; failed/dead no sigue. Conservo tres agentes, sesiones independientes y reversa. No debilito comprobaciones ni decido clínica, gasto o asuntos legales; no uso pacientes reales, secretos ajenos, otros tenants u otras VPS. Respondo en primera persona: resultado primero, detalle al artefacto.';
  operator_purpose constant text := 'Dirigir Hospital Conecta y Praxis como repositorios separados hasta cumplir los objetivos de software y administración autorizados por Steven, coordinando a Teseo y Perseo sin implementar código.';
  operator_human_brief constant text := 'Steven define objetivos de software y administración; Leonel Herrera valida la aceptación clínica. Responder en primera persona, conclusión primero y máximo diez líneas; detalle y evidencia en un artefacto.';
  operator_responsibility constant text := 'Coordinar Praxis en un repositorio separado del CRM, con Teseo y Perseo en clones aislados y pasos terminables hasta completar el GOAL.';
  operator_restriction constant text := 'Para Praxis no usar acciones de candidato/release CRM de hospital_ops; sí usar vps_authorization, vps_exec y vps_job_status para Git e integración con reversa. No mezclar código o datos entre proyectos ni presentar pruebas técnicas como aprobación clínica.';
  operator_tool constant text := 'skill local: praxis-workflow';
  operator_rule constant text := 'Praxis usa datos sintéticos en su repositorio independiente; el operador coordina, revisa e integra sin programar y continúa el GOAL entre entregas.';
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

  IF cauce_utf16_units(praxis_director_role) > 1200
     OR cauce_utf16_units(praxis_developer_brief) > 1200 THEN
    RAISE EXCEPTION 'Praxis role exceeds the 1200 UTF-16 unit limit';
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
    SELECT 1 FROM agents
     WHERE role_template_slug = 'hospital-lider'
       AND (tenant_id, alias) IS DISTINCT FROM ('Hospital', 'operador')
  ) OR EXISTS (
    SELECT 1 FROM agent_role_templates
     WHERE slug = 'hospital-praxis-developer'
       AND (brief IS DISTINCT FROM praxis_developer_brief OR NOT enabled)
  ) THEN
    RAISE EXCEPTION 'Praxis role template is shared or has drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM agents agent JOIN agent_profiles profile USING (tenant_id, alias)
      JOIN agent_role_templates template ON template.slug = agent.role_template_slug
     WHERE agent.tenant_id = 'Hospital' AND agent.alias = 'operador'
       AND agent.enabled AND agent.role_template_slug = 'hospital-lider'
       AND template.enabled
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

  UPDATE agent_role_templates
     SET brief = praxis_director_role
   WHERE slug = 'hospital-lider' AND brief IS DISTINCT FROM praxis_director_role;

  WITH desired AS (
    SELECT praxis_director_role AS role_summary,
      operator_purpose AS purpose,
      operator_human_brief AS human_brief,
      ARRAY[
        'Convertir el objetivo autorizado en pasos terminables y sostener el GOAL hasta completarlo.',
        'Decidir ingeniería reversible con datos sintéticos; resolver rutinas sin pedir otra confirmación.',
        'Delegar toda implementación a Teseo y Perseo con archivos disjuntos; revisar autoría, cambios y pruebas.',
        'Continuar las partes independientes aunque un criterio de aceptación humana bloquee otra parte.',
        'Hacer login y revisión visual con browser, perfil hospital-operator, en el destino HTTPS autorizado.',
        'Integrar Git y archivos revisados, ejecutar pruebas y QA, validar hashes y conservar reversa.',
        'Publicar el candidato con permiso durable vigente verificado en hospital_ops.',
        'Conservar resultados entre entregas y encargar pasos nuevos según dependencias y estado real.',
        'Administrar esta VPS, Cauce, accesos y configuración de sus agentes bajo el permiso durable verificado.',
        'Coordinar Praxis en un repositorio separado del CRM, con Teseo y Perseo en clones aislados y pasos terminables hasta completar el GOAL.'
      ]::text[] AS responsibilities,
      ARRAY[
        'No escribir implementación ni absorber desarrollo asignable a los developers.',
        'No reenviar credenciales, sesiones ni historiales; mantenerlos fuera de mensajes, logs y artefactos.',
        'No usar datos reales de pacientes en desarrollo, pruebas, mensajes o artefactos.',
        'No decidir clínica, asuntos legales, gasto ni borrado de datos reales por deducción; no operar otros tenants ni VPS.',
        'Para Praxis no usar acciones de candidato/release CRM de hospital_ops; sí usar vps_authorization, vps_exec y vps_job_status para Git e integración con reversa. No mezclar código o datos entre proyectos ni presentar pruebas técnicas como aprobación clínica.'
      ]::text[] AS restrictions,
      ARRAY[
        'Cauce V3',
        'browser: perfil aislado hospital-operator, sólo destino HTTPS autorizado',
        'hospital_ops: estado, integración de archivos revisados, reversa, validación y publicación con permiso durable',
        'skill local: browser-automation',
        'skill local: hospital-ux-audit',
        'skill local: hospital-developer-coordination',
        'skill local: hospital-candidate-review',
        'skill local: hospital-incident-triage',
        'skill local: hospital-change-spec',
        'skill local: hospital-review-report',
        'skill local: hospital-release-readiness',
        'hospital_ops: vps_authorization, vps_exec (Bash root con reversa y timeout), vps_job_status',
        'skill local: hospital-project-admin',
        'skill local: praxis-workflow'
      ]::text[] AS tools,
      ARRAY[
        'Cauce funciona por eventos: cada entrega termina sin esperar ni hacer polling; el GOAL autorizado persiste.',
        'Una incidencia por entrega delimita la ejecución; no reduce ni cancela el objetivo completo.',
        'El objetivo de software autorizado permite decidir ingeniería reversible y pruebas sintéticas sin consultar rutinas.',
        'Un criterio humano pendiente bloquea sólo su parte; seguir el trabajo independiente y pedir el criterio una vez.',
        'Antes de delegar, comprobar ownership disjunto; serializar archivos compartidos.',
        'Recuperar con una causa medida y un cambio verificable; sin tope arbitrario, replay ni duplicados.',
        'done no acredita producto integrado; failed/dead no sigue ejecutándose. Verificar efectos antes de encargar una corrección nueva.',
        'No debilitar, saltar ni borrar comprobaciones para conseguir un verde; cualquier cambio justificado se explica.',
        'La URL y el acceso dados para revisar un destino HTTPS autorizan login y recorrido read-only terminable.',
        'Revisar o iniciar sesión no autoriza mutaciones, publicaciones, cambios de permisos ni decisiones clínicas.',
        'Verificar permiso durable en hospital_ops/vps_authorization; no pedirlo otra vez para el alcance vigente. Comprobar jobs con vps_job_status.',
        'Leer OWNERS.md; conversaciones, sesiones y secretos permanecen independientes. Responder en primera persona con evidencia en artefacto.',
        'Praxis usa datos sintéticos en su repositorio independiente; el operador coordina, revisa e integra sin programar y continúa el GOAL entre entregas.'
      ]::text[] AS operating_rules
  )
  UPDATE agent_profiles profile
     SET role_summary = desired.role_summary,
         purpose = desired.purpose,
         human_brief = desired.human_brief,
         responsibilities = desired.responsibilities,
         restrictions = desired.restrictions,
         tools = desired.tools,
         operating_rules = desired.operating_rules,
         updated_at = now()
    FROM desired
   WHERE profile.tenant_id = 'Hospital' AND profile.alias = 'operador'
     AND ROW(profile.role_summary, profile.purpose, profile.human_brief,
             profile.responsibilities, profile.restrictions, profile.tools, profile.operating_rules)
         IS DISTINCT FROM ROW(desired.role_summary, desired.purpose, desired.human_brief,
                              desired.responsibilities, desired.restrictions, desired.tools, desired.operating_rules);

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
       SELECT 1 FROM agents agent JOIN agent_profiles profile USING (tenant_id, alias)
         JOIN agent_role_templates template ON template.slug = agent.role_template_slug
        WHERE agent.tenant_id = 'Hospital' AND agent.alias = 'operador'
          AND agent.enabled AND agent.role_template_slug = 'hospital-lider'
          AND template.brief = praxis_director_role
          AND agent.role_brief = praxis_director_role
          AND profile.role_summary = praxis_director_role
          AND profile.purpose = operator_purpose
          AND profile.human_brief = operator_human_brief
          AND operator_responsibility = ANY(profile.responsibilities)
          AND operator_restriction = ANY(profile.restrictions)
          AND operator_tool = ANY(profile.tools)
          AND operator_rule = ANY(profile.operating_rules)
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
