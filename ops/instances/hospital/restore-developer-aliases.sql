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

  IF active_aliases IS DISTINCT FROM ARRAY['operador', 'perseo', 'teseo']::text[]
     AND active_aliases IS DISTINCT FROM ARRAY['backend', 'frontend', 'operador']::text[]
  THEN
    RAISE EXCEPTION 'hospital developer restore requires an exact new or old active topology: %',
      active_aliases;
  END IF;

  IF EXISTS (
    SELECT 1 FROM messages
     WHERE tenant_id = 'Hospital' AND actor_alias IN ('teseo', 'perseo')
  ) OR EXISTS (
    SELECT 1 FROM deliveries
     WHERE recipient_tenant = 'Hospital' AND recipient_alias IN ('teseo', 'perseo')
  ) THEN
    RAISE EXCEPTION 'new developer history exists; restore the pre-cutover dump instead';
  END IF;
END
$guard$;

DELETE FROM connection_leases
 WHERE tenant_id = 'Hospital' AND alias IN ('backend', 'frontend', 'teseo', 'perseo');
DELETE FROM delivery_lane_fairness
 WHERE tenant_id = 'Hospital' AND alias IN ('backend', 'frontend', 'teseo', 'perseo');

DELETE FROM memberships
 WHERE tenant_id = 'Hospital' AND alias IN ('teseo', 'perseo');
DELETE FROM agent_profiles
 WHERE tenant_id = 'Hospital' AND alias IN ('teseo', 'perseo');
DELETE FROM agents
 WHERE tenant_id = 'Hospital' AND alias IN ('teseo', 'perseo');

INSERT INTO agent_role_templates(slug, display_name, brief, enabled)
VALUES
  (
    'hospital-lider',
    'Líder técnico hospitalario',
    'Sos el líder técnico de Hospital Conecta. Repartís trabajo entre backend y frontend, exigís pruebas, integrás sólo resultados verificados y conservás el control humano sobre producción, secretos y datos sensibles.',
    true
  ),
  (
    'hospital-developer',
    'Developer hospitalario',
    'Sos developer de Hospital Conecta. Ejecutás en tu workspace, trabajás sólo sobre datos sintéticos, entregás cambios acotados con pruebas y devolvés al operador cualquier decisión clínica, de producción o de credenciales.',
    true
  )
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  brief = EXCLUDED.brief,
  enabled = EXCLUDED.enabled;

UPDATE agents
   SET enabled = true,
       role_brief = (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
       updated_at = now()
 WHERE tenant_id = 'Hospital' AND alias IN ('backend', 'frontend');

UPDATE agents
   SET role_brief = (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-lider'),
       display_name = 'Operador de Hospital Conecta',
       updated_at = now()
 WHERE tenant_id = 'Hospital' AND alias = 'operador';

UPDATE memberships
   SET enabled = true
 WHERE tenant_id = 'Hospital'
   AND room_id = 'grp.hospital'
   AND alias IN ('backend', 'frontend');

UPDATE agent_profiles
   SET purpose = NULL,
       role_summary = (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-developer'),
       responsibilities = ARRAY[]::text[],
       restrictions = ARRAY[]::text[],
       human_brief = NULL,
       tools = ARRAY[]::text[],
       operating_rules = ARRAY[]::text[],
       updated_at = now()
 WHERE tenant_id = 'Hospital' AND alias IN ('backend', 'frontend');

UPDATE agent_profiles
   SET purpose = NULL,
       role_summary = (SELECT brief FROM agent_role_templates WHERE slug = 'hospital-lider'),
       responsibilities = ARRAY[]::text[],
       restrictions = ARRAY[]::text[],
       human_brief = NULL,
       tools = ARRAY[]::text[],
       operating_rules = ARRAY[]::text[],
       updated_at = now()
 WHERE tenant_id = 'Hospital' AND alias = 'operador';

DO $verify$
BEGIN
  IF (SELECT array_agg(alias ORDER BY alias) FROM agents
       WHERE tenant_id = 'Hospital' AND enabled)
       IS DISTINCT FROM ARRAY['backend', 'frontend', 'operador']::text[]
     OR (SELECT count(*) FROM agents WHERE tenant_id = 'Hospital') <> 3
     OR (SELECT count(*) FROM agent_profiles WHERE tenant_id = 'Hospital') <> 3
     OR (SELECT count(*) FROM memberships WHERE tenant_id = 'Hospital') <> 4
     OR EXISTS (
       SELECT 1 FROM connection_leases
        WHERE tenant_id = 'Hospital' AND alias IN ('backend', 'frontend', 'teseo', 'perseo')
     )
  THEN
    RAISE EXCEPTION 'hospital developer restore verification failed';
  END IF;
END
$verify$;

COMMIT;

SELECT alias, display_name, enabled, container_name, state_directory
  FROM agents
 WHERE tenant_id = 'Hospital'
 ORDER BY alias;
