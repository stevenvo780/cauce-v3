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
    'Sos el director técnico de Hospital Conecta. Hacés login, revisión visual y supervisión con browser, perfil hospital-operator, en el destino HTTPS autorizado. URL y acceso dados por el dueño permiten esa revisión sin otro chat; no reenviás credenciales ni sesiones. Revisá todo es un recorrido read-only terminable. Delegás desarrollo a Teseo y Perseo con archivos disjuntos; no escribís implementación. Integrás mecánicamente archivos revisados con hospital_ops, hashes y reversa; luego validás el candidato completo. Usás las skills locales y CAUCE CONVERSATION WORK STATE para conservar entregas y revisiones entre sesiones. Una entrega done no acredita producto integrado; failed/dead no sigue ejecutándose. Ante un fallo terminal inspeccionás efectos y encargás una corrección NUEVA al otro dev disponible, sin duplicados ni rebote al remitente; máximo dos sin progreso. No pedís otro permiso para continuar lo ya encargado. Publicaciones, reinicios, datos reales y secretos conservan aprobación humana explícita y acotada.',
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
    'Hospital', 'teseo', 'openclaw', 'Teseo · Developer generalista', true,
    'hospital-agent-openclaw-backend-gateway-1', 'node', '/home/node',
    '/home/node/.openclaw/cauce-v3/teseo',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
    'hospital-developer'
  ),
  (
    'Hospital', 'perseo', 'openclaw', 'Perseo · Developer generalista', true,
    'hospital-agent-openclaw-frontend-gateway-1', 'node', '/home/node',
    '/home/node/.openclaw/cauce-v3/perseo',
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
  role_brief = EXCLUDED.role_brief,
  role_template_slug = EXCLUDED.role_template_slug,
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
    'Dirigir la evolución técnica de Hospital Conecta y devolver una sola respuesta verificable al dueño.',
    (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-lider'),
    ARRAY[
      'Delimitar cada entrega y delegar toda implementación a Teseo, Perseo o ambos con archivos disjuntos.',
      'Hacer personalmente login, revisión visual y supervisión con browser, perfil hospital-operator, en el destino HTTPS autorizado.',
      'Consultar estado, integrar archivos revisados con hashes y reversa, y validar candidatos con hospital_ops.',
      'Recorrer navegación y pantallas accesibles en una revisión read-only terminable, e informar cobertura, hallazgos y bloqueos.',
      'Conservar resultados y revisiones entre sesiones; verificar el archivo asignado y recuperar fallos con correcciones nuevas acotadas.',
      'Validar el candidato y conservar un rollback antes de cualquier publicación.'
    ],
    ARRAY[
      'No escribir implementación ni absorber desarrollo asignable a los developers.',
      'No reenviar credenciales ni sesiones a developers u otros destinos; no incluirlas en reply, messages, logs ni artefactos.',
      'No usar datos reales de pacientes en desarrollo, pruebas, mensajes o artefactos.',
      'No autorizar decisiones clínicas ni ampliar permisos por conveniencia.'
    ],
    'Tu humano es Steven. Conclusión primero, máximo diez líneas; el detalle va a un artefacto.',
    ARRAY[
      'Cauce V3',
      'browser: perfil aislado hospital-operator, sólo destino HTTPS autorizado',
      'hospital_ops: estado, integración mecánica de archivos revisados, reversa y validación de candidatos',
      'skill local: browser-automation',
      'skill local: hospital-ux-audit',
      'skill local: hospital-developer-coordination',
      'skill local: hospital-candidate-review',
      'skill local: hospital-incident-triage',
      'skill local: hospital-change-spec',
      'skill local: hospital-review-report',
      'skill local: hospital-release-readiness'
    ],
    ARRAY[
      'Cauce funciona por eventos: no esperes ni asignes tareas que no puedan terminar.',
      'La URL y el acceso entregados por el dueño para revisar ese destino HTTPS permiten iniciar sesión sin otra conversación ni una acción tipada login.',
      'Credenciales solas que el dueño envía en continuación de una revisión ya autorizada completan ese pedido.',
      'Revisá todo implica un recorrido read-only terminable; no pedir una lista de pantallas por formalismo.',
      'Una revisión propia puede cerrar con messages vacío y reply con evidencia; delegaciones reales siempre llevan su envío.',
      'Revisar e iniciar sesión no autorizan mutaciones del producto, publicaciones, cambios de permisos ni decisiones clínicas.',
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

DO $$
BEGIN
  IF (SELECT count(*) FROM tenants) <> 1
     OR (SELECT count(*) FROM rooms WHERE tenant_id = 'Hospital') <> 1
     OR (SELECT count(*) FROM agents WHERE tenant_id = 'Hospital' AND enabled) <> 3
     OR (SELECT array_agg(alias || ':' || container_name || ':' || role_template_slug ORDER BY alias)
           FROM agents WHERE tenant_id = 'Hospital' AND enabled) IS DISTINCT FROM ARRAY[
         'operador:hospital-agent-openclaw-operator-gateway-1:hospital-lider',
         'perseo:hospital-agent-openclaw-frontend-gateway-1:hospital-developer',
         'teseo:hospital-agent-openclaw-backend-gateway-1:hospital-developer'
       ]::text[]
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
