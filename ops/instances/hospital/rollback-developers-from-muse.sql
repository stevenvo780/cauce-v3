\set ON_ERROR_STOP on

BEGIN;
LOCK TABLE agents, connection_leases, deliveries IN SHARE ROW EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM agents WHERE tenant_id = 'Hospital' AND enabled) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM agents WHERE tenant_id = 'Hospital' AND alias = 'operador'
         AND enabled AND harness_id = 'openclaw'
         AND container_name = 'hospital-agent-openclaw-operator-gateway-1'
     )
     OR NOT EXISTS (
       SELECT 1 FROM agents WHERE tenant_id = 'Hospital' AND alias = 'teseo'
         AND enabled AND harness_id = 'muse'
         AND container_name = 'hospital-agent-muse-backend-1'
     )
     OR NOT EXISTS (
       SELECT 1 FROM agents WHERE tenant_id = 'Hospital' AND alias = 'perseo'
         AND enabled AND harness_id = 'muse'
         AND container_name = 'hospital-agent-muse-frontend-1'
     )
     OR EXISTS (
       SELECT 1 FROM deliveries
        WHERE recipient_tenant = 'Hospital'
          AND recipient_alias IN ('teseo', 'perseo')
          AND terminal_at IS NULL
     )
  THEN
    RAISE EXCEPTION 'Hospital Muse rollback requires three expected agents and no open developer deliveries';
  END IF;
END
$guard$;

UPDATE agents
   SET harness_id = 'openclaw',
       container_name = CASE alias
         WHEN 'teseo' THEN 'hospital-agent-openclaw-backend-gateway-1'
         ELSE 'hospital-agent-openclaw-frontend-gateway-1'
       END,
       state_directory = '/home/node/.openclaw/cauce-v3/' || alias,
       updated_at = now()
 WHERE tenant_id = 'Hospital' AND alias IN ('teseo', 'perseo');

DELETE FROM connection_leases
 WHERE tenant_id = 'Hospital' AND alias IN ('teseo', 'perseo');

COMMIT;
