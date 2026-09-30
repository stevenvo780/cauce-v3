\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  hospital_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM tenants WHERE id = 'Hospital') INTO hospital_exists;

  IF hospital_exists THEN
    IF (SELECT count(*) FROM tenants) <> 1
       OR (SELECT count(*) FROM rooms) <> 1
       OR NOT EXISTS (
         SELECT 1 FROM tenants
          WHERE id = 'Hospital' AND enabled = true AND is_hub = true
       )
       OR NOT EXISTS (
         SELECT 1 FROM rooms
          WHERE id = 'grp.hospital' AND tenant_id = 'Hospital' AND enabled = true
       )
       OR (SELECT count(*) FROM agents WHERE tenant_id = 'Hospital' AND enabled) <> 3
       OR (SELECT count(*) FROM memberships WHERE tenant_id = 'Hospital' AND enabled) <> 4
       OR EXISTS (SELECT 1 FROM acl_edges)
    THEN
      RAISE EXCEPTION 'hospital topology drifted; bootstrap refuses to rewrite it';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM agents)
       OR EXISTS (SELECT 1 FROM messages)
       OR EXISTS (SELECT 1 FROM deliveries)
       OR EXISTS (SELECT 1 FROM console_users)
    THEN
      RAISE EXCEPTION 'hospital bootstrap requires a fresh migrated database';
    END IF;

    DELETE FROM acl_edges;
    DELETE FROM memberships;
    DELETE FROM rooms;
    DELETE FROM tenants;
  END IF;
END $$;

INSERT INTO tenants(id, display_name, enabled, is_hub)
VALUES ('Hospital', 'Hospital Conecta', true, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rooms(id, tenant_id, display_name, enabled)
VALUES ('grp.hospital', 'Hospital', 'Equipo de desarrollo Hospital Conecta', true)
ON CONFLICT (id) DO NOTHING;

UPDATE role_policies
   SET allow_route = true,
       allow_read = true,
       allow_control = true,
       allow_notify = true
 WHERE role = 'operator';

INSERT INTO agent_role_templates(slug, display_name, brief, enabled)
VALUES
  (
    'hospital-lider',
    'Director técnico hospitalario',
    'Soy el director de Hospital Conecta. Steven define objetivos de software y administración; Leonel valida lo clínico. Decido ingeniería reversible con datos sintéticos y sigo hasta cumplir el objetivo autorizado, sin consultar rutinas. Teseo y Perseo implementan en archivos y clones disjuntos; no escribo implementación. Coordino, reviso, integro Git, pruebas, QA y publicación con permiso durable verificado en hospital_ops. CRM y Praxis conservan repositorios y datos separados; para Praxis uso vps_authorization, vps_exec y vps_job_status. Un criterio humano pendiente bloquea sólo su parte: continúo el trabajo independiente. Cada entrega es terminable, no espera; el GOAL persiste y encargo pasos nuevos según dependencias. Recupero con causas medidas, sin replay ni duplicados: done no acredita producto integrado; failed/dead no sigue. Conservo tres agentes, sesiones independientes y reversa. No debilito comprobaciones ni decido clínica, gasto o asuntos legales; no uso pacientes reales, secretos ajenos, otros tenants u otras VPS. Respondo en primera persona: resultado primero, detalle al artefacto.',
    true
  ),
  (
    'hospital-developer',
    'Developer generalista hospitalario',
    'Sos developer generalista de Hospital Conecta. Ejecutás cualquier capa que el director te asigne dentro de tu candidato aislado, trabajás sólo con datos sintéticos y cerrás con evidencia reproducible.',
    true
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO harness_definitions(id, display_name, capabilities)
VALUES ('muse', 'Muse Code', '["messages.receive","jobs.interactive","jobs.batch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agents(
  tenant_id, alias, harness_id, display_name, enabled,
  container_name, runtime_user, home_directory, state_directory,
  role_brief, role_template_slug
)
VALUES
  (
    'Hospital', 'operador', 'openclaw', 'Operador de Hospital Conecta', true,
    'hospital-agent-openclaw-operator-gateway-1', 'node', '/home/node',
    '/home/node/.openclaw/cauce-v3/operador',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-lider'),
    'hospital-lider'
  ),
  (
    'Hospital', 'teseo', 'muse', 'Teseo · Developer generalista', true,
    'hospital-agent-muse-backend-1', 'node', '/home/node',
    '/home/node/.muse/cauce-v3/teseo',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    'hospital-developer'
  ),
  (
    'Hospital', 'perseo', 'muse', 'Perseo · Developer generalista', true,
    'hospital-agent-muse-frontend-1', 'node', '/home/node',
    '/home/node/.muse/cauce-v3/perseo',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    'hospital-developer'
  )
ON CONFLICT (tenant_id, alias) DO UPDATE SET
  harness_id = EXCLUDED.harness_id,
  display_name = EXCLUDED.display_name,
  enabled = EXCLUDED.enabled,
  container_name = EXCLUDED.container_name,
  runtime_user = EXCLUDED.runtime_user,
  home_directory = EXCLUDED.home_directory,
  state_directory = EXCLUDED.state_directory,
  updated_at = now();

INSERT INTO memberships(tenant_id, room_id, alias, role, enabled)
VALUES
  ('Hospital', 'grp.hospital', 'operador', 'operator', true),
  ('Hospital', 'grp.hospital', 'teseo', 'agent', true),
  ('Hospital', 'grp.hospital', 'perseo', 'agent', true),
  ('Hospital', 'grp.hospital', 'console-proxy', 'operator', true)
ON CONFLICT (tenant_id, room_id, alias) DO UPDATE SET
  role = EXCLUDED.role,
  enabled = EXCLUDED.enabled;

INSERT INTO agent_profiles(
  tenant_id, alias, purpose, role_summary, responsibilities,
  restrictions, human_brief, tools, operating_rules
)
VALUES
  (
    'Hospital', 'operador',
    'Dirigir Hospital Conecta hasta cumplir los objetivos de software y administración autorizados por Steven, coordinando a Teseo y Perseo sin implementar código.',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-lider'),
    ARRAY[
      'Convertir el objetivo autorizado en pasos terminables y sostener el GOAL hasta completarlo.',
      'Decidir ingeniería reversible con datos sintéticos; resolver rutinas sin pedir otra confirmación.',
      'Delegar toda implementación a Teseo y Perseo con archivos disjuntos; revisar autoría, cambios y pruebas.',
      'Continuar las partes independientes aunque un criterio de aceptación humana bloquee otra parte.',
      'Hacer login y revisión visual con browser, perfil hospital-operator, en el destino HTTPS autorizado.',
      'Integrar Git y archivos revisados, ejecutar pruebas y QA, validar hashes y conservar reversa.',
      'Publicar el candidato con permiso durable vigente verificado en hospital_ops.',
      'Conservar resultados entre entregas y encargar pasos nuevos según dependencias y estado real.',
      'Administrar esta VPS, Cauce, accesos y configuración de sus agentes bajo el permiso durable verificado.'
    ],
    ARRAY[
      'No escribir implementación ni absorber desarrollo asignable a los developers.',
      'No reenviar credenciales, sesiones ni historiales; mantenerlos fuera de mensajes, logs y artefactos.',
      'No usar datos reales de pacientes en desarrollo, pruebas, mensajes o artefactos.',
      'No decidir clínica, asuntos legales, gasto ni borrado de datos reales por deducción; no operar otros tenants ni VPS.'
    ],
    'Steven define objetivos de software y administración; Leonel Herrera valida la aceptación clínica. Responder en primera persona, conclusión primero y máximo diez líneas; detalle y evidencia en un artefacto.',
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
      'skill local: hospital-project-admin'
    ],
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
      'Leer OWNERS.md; conversaciones, sesiones y secretos permanecen independientes. Responder en primera persona con evidencia en artefacto.'
    ]
  ),
  (
    'Hospital', 'teseo',
    'Construir y probar cualquier capa asignada del CRM hospitalario dentro de un candidato aislado.',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    ARRAY[
      'Trabajar sólo sobre los archivos asignados dentro de su candidato completo y aislado.',
      'Entregar al operador pasos reproducibles, salida de tests y riesgos pendientes.'
    ],
    ARRAY[
      'No leer secretos, bases reales, sesiones, dumps ni datos de pacientes.',
      'No escribir archivos asignados a Perseo ni desplegar.'
    ],
    'Tu humano es Steven; el operador coordina el trabajo cotidiano y devuelve el resultado.',
    ARRAY['lectura y edición del workspace', 'shell dentro del contenedor', 'tests locales'],
    ARRAY['No delegues lo que podés ejecutar en tu propio workspace.', 'Cerrá cada turno con evidencia.']
  ),
  (
    'Hospital', 'perseo',
    'Construir y probar cualquier capa asignada del CRM hospitalario dentro de un candidato aislado.',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    ARRAY[
      'Trabajar sólo sobre los archivos asignados dentro de su candidato completo y aislado.',
      'Entregar al operador pasos reproducibles, salida de tests y riesgos pendientes.'
    ],
    ARRAY[
      'No leer secretos, bases reales, sesiones, dumps ni datos de pacientes.',
      'No escribir archivos asignados a Teseo ni desplegar.'
    ],
    'Tu humano es Steven; el operador coordina el trabajo cotidiano y devuelve el resultado.',
    ARRAY['lectura y edición del workspace', 'shell dentro del contenedor', 'tests locales'],
    ARRAY['No delegues lo que podés ejecutar en tu propio workspace.', 'Cerrá cada turno con evidencia.']
  )
ON CONFLICT (tenant_id, alias) DO UPDATE SET
  purpose = EXCLUDED.purpose,
  role_summary = EXCLUDED.role_summary,
  responsibilities = EXCLUDED.responsibilities,
  restrictions = EXCLUDED.restrictions,
  human_brief = EXCLUDED.human_brief,
  tools = EXCLUDED.tools,
  operating_rules = EXCLUDED.operating_rules,
  updated_at = now()
WHERE agent_profiles.purpose IS NULL;

DO $$
BEGIN
  IF (SELECT count(*) FROM tenants) <> 1
     OR (SELECT count(*) FROM rooms WHERE tenant_id = 'Hospital') <> 1
     OR (SELECT count(*) FROM agents WHERE tenant_id = 'Hospital' AND enabled) <> 3
     OR ((SELECT array_agg(alias || ':' || container_name || ':' || role_template_slug ORDER BY alias)
           FROM agents WHERE tenant_id = 'Hospital' AND enabled) IS DISTINCT FROM ARRAY[
         'operador:hospital-agent-openclaw-operator-gateway-1:hospital-lider',
         'perseo:hospital-agent-muse-frontend-1:hospital-developer',
         'teseo:hospital-agent-muse-backend-1:hospital-developer'
       ]::text[]
        AND (SELECT array_agg(alias || ':' || container_name || ':' || role_template_slug ORDER BY alias)
               FROM agents WHERE tenant_id = 'Hospital' AND enabled) IS DISTINCT FROM ARRAY[
             'operador:hospital-agent-openclaw-operator-gateway-1:hospital-lider',
             'perseo:hospital-agent-muse-frontend-1:hospital-praxis-developer',
             'teseo:hospital-agent-muse-backend-1:hospital-praxis-developer'
           ]::text[])
     OR (SELECT count(*) FROM agent_profiles p JOIN agents a USING (tenant_id, alias)
          WHERE p.tenant_id = 'Hospital' AND a.enabled) <> 3
     OR (SELECT count(*) FROM memberships WHERE tenant_id = 'Hospital' AND enabled) <> 4
     OR (SELECT array_agg(alias || ':' || role ORDER BY alias)
           FROM memberships WHERE tenant_id = 'Hospital' AND enabled) IS DISTINCT FROM ARRAY[
         'console-proxy:operator', 'operador:operator', 'perseo:agent', 'teseo:agent'
       ]::text[]
     OR (SELECT count(*) FROM memberships WHERE tenant_id = 'Hospital' AND role = 'operator' AND enabled) <> 2
     OR (SELECT count(*) FROM memberships WHERE tenant_id = 'Hospital' AND role = 'agent' AND enabled) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM agent_role_templates
        WHERE slug = 'hospital-lider' AND enabled = true
     )
     OR NOT EXISTS (
       SELECT 1 FROM agent_role_templates
        WHERE slug = 'hospital-developer' AND enabled = true
     )
     OR EXISTS (SELECT 1 FROM acl_edges)
  THEN
    RAISE EXCEPTION 'hospital topology verification failed';
  END IF;
END $$;

COMMIT;

SELECT
  (SELECT count(*) FROM tenants) AS tenants,
  (SELECT count(*) FROM rooms) AS rooms,
  (SELECT count(*) FROM agents WHERE enabled) AS agents,
  (SELECT count(*) FROM agent_profiles p JOIN agents a USING (tenant_id, alias) WHERE a.enabled) AS profiles,
  (SELECT count(*) FROM acl_edges) AS acl_edges;
