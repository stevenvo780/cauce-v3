\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE agents, memberships, agent_profiles, connection_leases, delivery_lane_fairness
  IN SHARE ROW EXCLUSIVE MODE;

DO $guard$
DECLARE
  active_aliases text[];
BEGIN
  SELECT array_agg(alias ORDER BY alias)
    INTO active_aliases
    FROM agents
   WHERE tenant_id = 'Hospital' AND enabled;

  IF active_aliases IS DISTINCT FROM ARRAY['backend', 'frontend', 'operador']::text[]
     AND active_aliases IS DISTINCT FROM ARRAY['operador', 'perseo', 'teseo']::text[]
  THEN
    RAISE EXCEPTION 'hospital developer rename requires an exact old or new active topology: %',
      active_aliases;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM deliveries
     WHERE recipient_tenant = 'Hospital'
       AND recipient_alias IN ('backend', 'frontend', 'teseo', 'perseo')
       AND terminal_at IS NULL
  ) THEN
    RAISE EXCEPTION 'hospital developer rename refuses non-terminal developer deliveries';
  END IF;
END
$guard$;

INSERT INTO agent_role_templates(slug, display_name, brief, enabled)
VALUES
  (
    'hospital-lider',
    'Director técnico hospitalario',
    'Sos el director técnico de Hospital Conecta. Delegás todo desarrollo a Teseo y Perseo en contextos separados; delimitás entregas, supervisás, exigís pruebas y aceptás sólo resultados verificados. No implementás cambios. Conservás el control humano sobre producción, secretos y datos sensibles.',
    true
  ),
  (
    'hospital-developer',
    'Developer generalista hospitalario',
    'Sos developer generalista de Hospital Conecta. Ejecutás cualquier capa que el director te asigne dentro de tu candidato aislado, trabajás sólo con datos sintéticos y cerrás con evidencia reproducible.',
    true
  )
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  brief = EXCLUDED.brief,
  enabled = EXCLUDED.enabled;

INSERT INTO agents(
  tenant_id, alias, harness_id, display_name, enabled,
  container_name, runtime_user, home_directory, state_directory,
  max_concurrent_deliveries, role_brief, role_template_slug
)
VALUES
  (
    'Hospital', 'teseo', 'openclaw', 'Teseo · Developer generalista', true,
    'hospital-agent-openclaw-backend-gateway-1', 'node', '/home/node',
    '/home/node/.openclaw/cauce-v3/teseo', 2,
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    'hospital-developer'
  ),
  (
    'Hospital', 'perseo', 'openclaw', 'Perseo · Developer generalista', true,
    'hospital-agent-openclaw-frontend-gateway-1', 'node', '/home/node',
    '/home/node/.openclaw/cauce-v3/perseo', 2,
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
  max_concurrent_deliveries = EXCLUDED.max_concurrent_deliveries,
  role_brief = EXCLUDED.role_brief,
  role_template_slug = EXCLUDED.role_template_slug,
  updated_at = now();

UPDATE agents
   SET role_brief = (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-lider'),
       display_name = 'Director de Hospital Conecta',
       updated_at = now()
 WHERE tenant_id = 'Hospital' AND alias = 'operador';

INSERT INTO memberships(tenant_id, room_id, alias, role, enabled)
VALUES
  ('Hospital', 'grp.hospital', 'teseo', 'agent', true),
  ('Hospital', 'grp.hospital', 'perseo', 'agent', true)
ON CONFLICT (tenant_id, room_id, alias) DO UPDATE SET
  role = EXCLUDED.role,
  enabled = EXCLUDED.enabled;

UPDATE memberships
   SET enabled = false
 WHERE tenant_id = 'Hospital'
   AND room_id = 'grp.hospital'
   AND alias IN ('backend', 'frontend');

UPDATE agents
   SET enabled = false,
       updated_at = now()
 WHERE tenant_id = 'Hospital' AND alias IN ('backend', 'frontend');

DELETE FROM connection_leases
 WHERE tenant_id = 'Hospital' AND alias IN ('backend', 'frontend', 'teseo', 'perseo');
DELETE FROM delivery_lane_fairness
 WHERE tenant_id = 'Hospital' AND alias IN ('backend', 'frontend', 'teseo', 'perseo');

INSERT INTO agent_profiles(
  tenant_id, alias, purpose, role_summary, responsibilities,
  restrictions, human_brief, tools, operating_rules
)
VALUES
  (
    'Hospital', 'operador',
    'Dirigir la evolución técnica de Hospital Conecta y devolver una sola respuesta verificable al dueño.',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-lider'),
    ARRAY[
      'Delimitar cada entrega y delegar toda implementación a Teseo, Perseo o ambos con archivos disjuntos.',
      'Supervisar la ejecución, revisar evidencia y pedir correcciones al developer responsable.',
      'Validar el candidato y conservar un rollback antes de cualquier publicación.'
    ],
    ARRAY[
      'No escribir implementación ni absorber trabajo asignable a los developers.',
      'No usar datos reales de pacientes en desarrollo, pruebas, mensajes o artefactos.',
      'No autorizar decisiones clínicas ni ampliar permisos por conveniencia.'
    ],
    'Tu humano es Steven. Conclusión primero, máximo diez líneas; el detalle va a un artefacto.',
    ARRAY['Cauce V3', 'hospital_ops', 'navegador aislado'],
    ARRAY[
      'Cauce funciona por eventos: no esperes ni asignes tareas que no puedan terminar.',
      'Producción, secretos y datos reales requieren una instrucción humana explícita y acotada.'
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
  updated_at = now();

DO $verify$
BEGIN
  IF (SELECT array_agg(alias ORDER BY alias) FROM agents
       WHERE tenant_id = 'Hospital' AND enabled)
       IS DISTINCT FROM ARRAY['operador', 'perseo', 'teseo']::text[]
     OR (SELECT array_agg(alias ORDER BY alias) FROM memberships
          WHERE tenant_id = 'Hospital' AND room_id = 'grp.hospital'
            AND role = 'agent' AND enabled)
       IS DISTINCT FROM ARRAY['perseo', 'teseo']::text[]
     OR EXISTS (
       SELECT 1 FROM connection_leases
        WHERE tenant_id = 'Hospital' AND alias IN ('backend', 'frontend', 'teseo', 'perseo')
     )
  THEN
    RAISE EXCEPTION 'hospital developer rename verification failed';
  END IF;
END
$verify$;

COMMIT;

SELECT alias, display_name, enabled, container_name, state_directory
  FROM agents
 WHERE tenant_id = 'Hospital'
 ORDER BY enabled DESC, alias;
