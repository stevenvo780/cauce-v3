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
       OR (SELECT count(*) FROM agents WHERE tenant_id = 'Hospital') <> 3
       OR (SELECT count(*) FROM memberships WHERE tenant_id = 'Hospital') <> 4
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
    'Líder técnico hospitalario',
    'Sos el director técnico de Hospital Conecta. Delegás todo desarrollo a backend y frontend en contextos separados; delimitás entregas, supervisás, exigís pruebas y aceptás sólo resultados verificados. No implementás cambios. Conservás el control humano sobre producción, secretos y datos sensibles.',
    true
  ),
  (
    'hospital-developer',
    'Developer hospitalario',
    'Sos developer de Hospital Conecta. Ejecutás en tu workspace, trabajás sólo sobre datos sintéticos, entregás cambios acotados con pruebas y devolvés al operador cualquier decisión clínica, de producción o de credenciales.',
    true
  )
ON CONFLICT (slug) DO NOTHING;

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
    'Hospital', 'backend', 'openclaw', 'Developer backend', true,
    'hospital-agent-openclaw-backend-gateway-1', 'node', '/home/node',
    '/home/node/.openclaw/cauce-v3/backend',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    'hospital-developer'
  ),
  (
    'Hospital', 'frontend', 'openclaw', 'Developer frontend', true,
    'hospital-agent-openclaw-frontend-gateway-1', 'node', '/home/node',
    '/home/node/.openclaw/cauce-v3/frontend',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    'hospital-developer'
  )
ON CONFLICT (tenant_id, alias) DO NOTHING;

INSERT INTO memberships(tenant_id, room_id, alias, role, enabled)
VALUES
  ('Hospital', 'grp.hospital', 'operador', 'operator', true),
  ('Hospital', 'grp.hospital', 'backend', 'agent', true),
  ('Hospital', 'grp.hospital', 'frontend', 'agent', true),
  ('Hospital', 'grp.hospital', 'console-proxy', 'operator', true)
ON CONFLICT (tenant_id, room_id, alias) DO NOTHING;

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
      'Delimitar cada entrega y delegar toda implementación a backend, frontend o ambos con archivos disjuntos.',
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
    'Hospital', 'backend',
    'Construir y probar servidor, persistencia, APIs y controles de seguridad del CRM hospitalario.',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    ARRAY[
      'Trabajar sobre la lógica backend y sus pruebas dentro del candidato compartido.',
      'Entregar al operador pasos reproducibles, salida de tests y riesgos pendientes.'
    ],
    ARRAY[
      'No leer secretos, bases reales, sesiones, dumps ni datos de pacientes.',
      'No tocar frontend ni desplegar salvo asignación humana explícita.'
    ],
    'Tu humano es Steven; el operador coordina el trabajo cotidiano y devuelve el resultado.',
    ARRAY['lectura y edición del workspace', 'shell dentro del contenedor', 'tests locales'],
    ARRAY['No delegues lo que podés ejecutar en tu propio workspace.', 'Cerrá cada turno con evidencia.']
  ),
  (
    'Hospital', 'frontend',
    'Construir y probar una interfaz hospitalaria clara, accesible y responsive.',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    ARRAY[
      'Trabajar sobre templates, estáticos y pruebas visuales dentro del candidato compartido.',
      'Entregar al operador capturas o salidas reproducibles para escritorio y móvil.'
    ],
    ARRAY[
      'No leer secretos, bases reales, sesiones, dumps ni datos de pacientes.',
      'No cambiar contratos backend ni desplegar salvo asignación humana explícita.'
    ],
    'Tu humano es Steven; el operador coordina el trabajo cotidiano y devuelve el resultado.',
    ARRAY['lectura y edición del workspace', 'shell dentro del contenedor', 'tests locales'],
    ARRAY['No delegues lo que podés ejecutar en tu propio workspace.', 'Cerrá cada turno con evidencia.']
  )
ON CONFLICT (tenant_id, alias) DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM tenants) <> 1
     OR (SELECT count(*) FROM rooms WHERE tenant_id = 'Hospital') <> 1
     OR (SELECT count(*) FROM agents WHERE tenant_id = 'Hospital' AND enabled) <> 3
     OR (SELECT array_agg(alias || ':' || container_name || ':' || role_template_slug ORDER BY alias)
           FROM agents WHERE tenant_id = 'Hospital') IS DISTINCT FROM ARRAY[
         'backend:hospital-agent-openclaw-backend-gateway-1:hospital-developer',
         'frontend:hospital-agent-openclaw-frontend-gateway-1:hospital-developer',
         'operador:hospital-agent-openclaw-operator-gateway-1:hospital-lider'
       ]::text[]
     OR (SELECT count(*) FROM agent_profiles WHERE tenant_id = 'Hospital') <> 3
     OR (SELECT count(*) FROM memberships WHERE tenant_id = 'Hospital' AND enabled) <> 4
     OR (SELECT array_agg(alias || ':' || role ORDER BY alias)
           FROM memberships WHERE tenant_id = 'Hospital') IS DISTINCT FROM ARRAY[
         'backend:agent', 'console-proxy:operator', 'frontend:agent', 'operador:operator'
       ]::text[]
     OR (SELECT count(*) FROM memberships WHERE tenant_id = 'Hospital' AND role = 'operator') <> 2
     OR (SELECT count(*) FROM memberships WHERE tenant_id = 'Hospital' AND role = 'agent') <> 2
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
  (SELECT count(*) FROM agent_profiles) AS profiles,
  (SELECT count(*) FROM acl_edges) AS acl_edges;
