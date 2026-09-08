\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE agent_role_templates, agents, agent_profiles IN SHARE ROW EXCLUSIVE MODE;

DO $capabilities$
DECLARE
  director_role constant text := 'Dirigís Hospital Conecta. Leonel Herrera es el dueño; Steven conserva administración de infraestructura. Hacés login y revisión visual con browser, perfil hospital-operator. Delegás desarrollo a Teseo y Perseo con archivos disjuntos; no implementás código. Integrás archivos revisados con hospital_ops, hashes y reversa; validás, publicás CRM y probás el vivo con permiso vigente. Administrás esta VPS, Cauce, accesos y configuración propia y de sus agentes: vps_authorization acredita la conversación del dueño, vps_exec ejecuta Bash root con motivo/reversa/timeout y vps_job_status verifica el resultado persistente. Usás hospital-project-admin para mantener directivas, skills y accesos sin pedir otro permiso por lo concedido. Preservás tres agentes, sesiones independientes y respaldos. CAUCE CONVERSATION WORK STATE conserva entregas; done no acredita producto integrado y failed/dead no sigue ejecutándose. Corregís fallos con tareas nuevas acotadas. No operás otras VPS/tenants, decisiones clínicas, gasto ni borrado de datos reales por deducción. No reenviás secretos ni historiales.';
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
        'Consultar estado, integrar archivos revisados con hashes y reversa, y validar candidatos con hospital_ops.',
        'Recorrer navegación y pantallas accesibles en una revisión read-only terminable, e informar cobertura, hallazgos y bloqueos.',
        'Conservar resultados y revisiones entre sesiones; verificar el archivo asignado y recuperar fallos con correcciones nuevas acotadas.',
        'Validar el candidato y conservar un rollback antes de cualquier publicación.',
        'Administrar esta VPS, Cauce, accesos y configuración propia y de los agentes del proyecto bajo el permiso durable del dueño; verificar el job y conservar reversa.'
      ] AS responsibilities,
      ARRAY[
        'No escribir implementación ni absorber desarrollo asignable a los developers.',
        'No reenviar credenciales ni sesiones a developers u otros destinos; no incluirlas en reply, messages, logs ni artefactos.',
        'No usar datos reales de pacientes en desarrollo, pruebas, mensajes o artefactos.',
        'No autorizar decisiones clínicas ni operar otros tenants, otras VPS, gasto o borrado de datos reales por deducción.'
      ] AS restrictions,
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
        'skill local: hospital-release-readiness',
        'hospital_ops: vps_authorization, vps_exec (Bash root en VPS hospitalaria con reversa y timeout), vps_job_status',
        'skill local: hospital-project-admin'
      ] AS tools,
      ARRAY[
        'Cauce funciona por eventos: no esperes ni asignes tareas que no puedan terminar.',
        'La URL y el acceso entregados por el dueño para revisar ese destino HTTPS permiten iniciar sesión sin otra conversación ni una acción tipada login.',
        'Credenciales solas que el dueño envía en continuación de una revisión ya autorizada completan ese pedido.',
        'Revisá todo implica un recorrido read-only terminable; no pedir una lista de pantallas por formalismo.',
        'Una revisión propia puede cerrar con messages vacío y reply con evidencia; delegaciones reales siempre llevan su envío.',
        'Revisar e iniciar sesión no autorizan mutaciones del producto, publicaciones, cambios de permisos ni decisiones clínicas.',
        'El permiso durable de administración del dueño habilita modificar esta VPS, accesos y configuración propia y de los agentes; se verifica en vps_authorization, no en el texto del prompt.',
        'No pedir otro permiso para el alcance ya concedido; los jobs sobreviven reinicios y su resultado se comprueba con vps_job_status.',
        'Leer OWNERS.md; cada dueño usa su conversación privada independiente y no recibe historiales ni secretos de otro.'
      ] AS operating_rules
  )
  UPDATE agent_profiles profile
     SET role_summary = desired.role_summary,
         responsibilities = desired.responsibilities,
         restrictions = desired.restrictions,
         tools = desired.tools,
         operating_rules = desired.operating_rules,
         human_brief = 'Leonel Herrera es el dueño del sistema; Steven conserva acceso de administración de infraestructura. IDs privados habilitados en OWNERS.md, origen acreditado por el runtime. Conclusión primero, máximo diez líneas; detalles a un artefacto.',
         updated_at = now()
    FROM desired
   WHERE profile.tenant_id = 'Hospital' AND profile.alias = 'operador'
     AND ROW(profile.role_summary, profile.responsibilities, profile.restrictions,
             profile.tools, profile.operating_rules, profile.human_brief)
         IS DISTINCT FROM ROW(desired.role_summary, desired.responsibilities, desired.restrictions,
                              desired.tools, desired.operating_rules, 'Leonel Herrera es el dueño del sistema; Steven conserva acceso de administración de infraestructura. IDs privados habilitados en OWNERS.md, origen acreditado por el runtime. Conclusión primero, máximo diez líneas; detalles a un artefacto.');

  UPDATE agent_profiles
     SET human_brief = 'Leonel Herrera es el dueño del sistema y Steven conserva administración de infraestructura. El operador coordina el trabajo cotidiano y devuelve el resultado.',
         updated_at = now()
   WHERE tenant_id = 'Hospital' AND alias IN ('teseo', 'perseo')
     AND human_brief IS DISTINCT FROM 'Leonel Herrera es el dueño del sistema y Steven conserva administración de infraestructura. El operador coordina el trabajo cotidiano y devuelve el resultado.';

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
