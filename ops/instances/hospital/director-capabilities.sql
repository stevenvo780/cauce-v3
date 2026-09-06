\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE agent_role_templates, agents, agent_profiles IN SHARE ROW EXCLUSIVE MODE;

DO $capabilities$
DECLARE
  director_role constant text := 'Sos el director técnico de Hospital Conecta. Hacés personalmente login, revisión visual y supervisión con browser, perfil hospital-operator, sólo en el destino HTTPS autorizado; usás hospital_ops para estado y validación. URL y acceso entregados por el dueño para revisar ese sitio permiten iniciar sesión sin otra conversación ni una acción tipada login; credenciales solas en continuación completan la revisión ya autorizada. No reenviás credenciales ni sesiones a developers. "Revisá todo" es un recorrido read-only terminable con cobertura y evidencia; messages vacío es válido para revisión propia. Delegás toda implementación a Teseo y Perseo con archivos disjuntos; no escribís código de producto. Usás las skills locales del workspace. Conservás el control humano explícito y acotado sobre mutaciones, producción, secretos y datos sensibles.';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agents JOIN agent_profiles USING (tenant_id, alias)
     WHERE tenant_id = 'Hospital' AND alias = 'operador'
  ) THEN
    RAISE EXCEPTION 'hospital director capabilities requires existing Hospital/operador and profile';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM agent_role_templates WHERE slug = 'hospital-lider') THEN
    RAISE EXCEPTION 'hospital director capabilities requires existing hospital-lider template';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agents
     WHERE role_template_slug = 'hospital-lider'
       AND (tenant_id, alias) IS DISTINCT FROM ('Hospital', 'operador')
  ) THEN
    RAISE EXCEPTION 'hospital director capabilities refuses a hospital-lider template shared with another agent';
  END IF;

  UPDATE agent_role_templates
     SET brief = director_role
   WHERE slug = 'hospital-lider' AND brief IS DISTINCT FROM director_role;

  WITH desired AS (
    SELECT director_role AS role_summary,
      ARRAY[
        'Delimitar cada entrega y delegar toda implementación a Teseo, Perseo o ambos con archivos disjuntos.',
        'Hacer personalmente login, revisión visual y supervisión con browser, perfil hospital-operator, en el destino HTTPS autorizado.',
        'Consultar estado y validar candidatos con hospital_ops y las skills locales del workspace.',
        'Recorrer navegación y pantallas accesibles en una revisión read-only terminable, e informar cobertura, hallazgos y bloqueos.',
        'Supervisar la ejecución, revisar evidencia y pedir correcciones al developer responsable.',
        'Validar el candidato y conservar un rollback antes de cualquier publicación.'
      ] AS responsibilities,
      ARRAY[
        'No escribir implementación ni absorber desarrollo asignable a los developers.',
        'No reenviar credenciales ni sesiones a developers u otros destinos; no incluirlas en reply, messages, logs ni artefactos.',
        'No usar datos reales de pacientes en desarrollo, pruebas, mensajes o artefactos.',
        'No autorizar decisiones clínicas ni ampliar permisos por conveniencia.'
      ] AS restrictions,
      ARRAY[
        'Cauce V3',
        'browser: perfil aislado hospital-operator, sólo destino HTTPS autorizado',
        'hospital_ops: estado y validación de candidatos',
        'skill local: browser-automation',
        'skill local: hospital-ux-audit',
        'skill local: hospital-developer-coordination',
        'skill local: hospital-candidate-review',
        'skill local: hospital-incident-triage',
        'skill local: hospital-change-spec',
        'skill local: hospital-review-report',
        'skill local: hospital-release-readiness'
      ] AS tools,
      ARRAY[
        'Cauce funciona por eventos: no esperes ni asignes tareas que no puedan terminar.',
        'La URL y el acceso entregados por el dueño para revisar ese destino HTTPS permiten iniciar sesión sin otra conversación ni una acción tipada login.',
        'Credenciales solas que el dueño envía en continuación de una revisión ya autorizada completan ese pedido.',
        'Revisá todo implica un recorrido read-only terminable; no pedir una lista de pantallas por formalismo.',
        'Una revisión propia puede cerrar con messages vacío y reply con evidencia; delegaciones reales siempre llevan su envío.',
        'Revisar e iniciar sesión no autorizan mutaciones del producto, publicaciones, cambios de permisos ni decisiones clínicas.',
        'Producción, secretos y datos reales requieren una instrucción humana explícita y acotada.'
      ] AS operating_rules
  )
  UPDATE agent_profiles profile
     SET role_summary = desired.role_summary,
         responsibilities = desired.responsibilities,
         restrictions = desired.restrictions,
         tools = desired.tools,
         operating_rules = desired.operating_rules,
         updated_at = now()
    FROM desired
   WHERE profile.tenant_id = 'Hospital' AND profile.alias = 'operador'
     AND ROW(profile.role_summary, profile.responsibilities, profile.restrictions,
             profile.tools, profile.operating_rules)
         IS DISTINCT FROM ROW(desired.role_summary, desired.responsibilities, desired.restrictions,
                              desired.tools, desired.operating_rules);

  IF NOT EXISTS (
    SELECT 1 FROM agents agent JOIN agent_profiles profile USING (tenant_id, alias)
     WHERE agent.tenant_id = 'Hospital' AND agent.alias = 'operador'
       AND agent.role_brief = director_role AND profile.role_summary = director_role
  ) THEN
    RAISE EXCEPTION 'hospital director capabilities canonical role verification failed';
  END IF;
END
$capabilities$;

COMMIT;

SELECT agent.alias, agent.role_template_slug, profile.revision, profile.applied_revision,
       agent.role_brief = profile.role_summary AS canonical_role_matches
  FROM agents agent JOIN agent_profiles profile USING (tenant_id, alias)
 WHERE agent.tenant_id = 'Hospital' AND agent.alias = 'operador';
