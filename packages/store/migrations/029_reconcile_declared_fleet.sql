-- Reconcile the durable registry with the 15-alias fleet declared in ops/container-aliases.json.
--
-- Safety properties:
--   * existing rows are updated in place; history, profiles, deliveries and epochs are preserved;
--   * connection_leases is deliberately never written (desired catalog != observed presence);
--   * known retired aliases remain as disabled history, never deleted;
--   * an append-only before/applied journal makes the down migration CAS-safe.

CREATE TABLE IF NOT EXISTS fleet_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_version text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  applied_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  CHECK ((active AND rolled_back_at IS NULL) OR (NOT active AND rolled_back_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_reconciliation_one_active_idx
  ON fleet_reconciliation_runs ((true)) WHERE active;

CREATE TABLE IF NOT EXISTS fleet_reconciliation_history (
  run_id uuid NOT NULL REFERENCES fleet_reconciliation_runs(id),
  entity text NOT NULL CHECK (entity IN ('agent','membership')),
  tenant_id text NOT NULL,
  alias text NOT NULL,
  room_id text NOT NULL DEFAULT '',
  previous jsonb,
  applied jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, entity, tenant_id, alias, room_id),
  CHECK (previous IS NULL OR jsonb_typeof(previous)='object'),
  CHECK (applied IS NULL OR jsonb_typeof(applied)='object')
);

INSERT INTO fleet_reconciliation_runs(migration_version)
SELECT '029_reconcile_declared_fleet.sql'
WHERE NOT EXISTS (SELECT 1 FROM fleet_reconciliation_runs WHERE active);

CREATE TEMP TABLE fleet_029_desired_agents (
  tenant_id text NOT NULL,
  alias text NOT NULL,
  harness_id text NOT NULL,
  container_name text NOT NULL,
  runtime_user text NOT NULL,
  home_directory text NOT NULL,
  state_directory text NOT NULL,
  room_id text NOT NULL,
  membership_role text NOT NULL,
  PRIMARY KEY (tenant_id, alias)
) ON COMMIT DROP;

INSERT INTO fleet_029_desired_agents VALUES
  ('Steven','argos','claude','ctrl-infra','dev','/home/dev','/home/dev/.local/state/cauce-v3/argos','grp.steven','agent'),
  ('Miguel','atlas','codex','ws-humanizar','dev','/home/dev','/home/dev/.local/state/cauce-v3/atlas','grp.miguel','agent'),
  ('Pablo','dedalo','codex','ws-pablo','dev','/home/dev','/workspace/.cauce-v3/dedalo','grp.pablo','agent'),
  ('Jhon','hegel','openclaw','agv2-jhon-hegel-oc','claw','/home/claw','/home/claw/.openclaw/cauce-v3/hegel','grp.jhon','agent'),
  ('Miguel','iza','hermes','ws-humanizar','dev','/home/dev','/home/dev/.local/state/cauce-v3/iza','grp.miguel','agent'),
  ('Miguel','janus','openclaw','claw-miguel','claw','/home/claw','/home/claw/.openclaw/cauce-v3/janus','grp.miguel','operator'),
  ('Steven','jarvis','openclaw','claw','claw','/home/claw','/home/claw/.openclaw/cauce-v3/jarvis','grp.steven','agent_notify'),
  ('Steven','kant','codex','host:kratos','stev','/home/stev','/home/stev/.local/state/cauce-v3/kant','grp.steven','operator'),
  ('Miguel','kratos','codex','ws-humanizar','dev','/home/dev','/home/dev/.local/state/cauce-v3/kratos','grp.miguel','agent'),
  ('Pablo','midas','openclaw','agv2-pablo-infra-oc','claw','/home/claw','/home/claw/.openclaw/cauce-v3/midas','grp.pablo','agent'),
  ('Isa','salva','codex','ws-isa','dev','/home/dev','/home/dev/.local/state/cauce-v3/salva','grp.isa','agent'),
  ('Pablo','seneca','openclaw','agv2-pablo-developer-oc','claw','/home/claw','/home/claw/.openclaw/cauce-v3/seneca','grp.pablo','agent'),
  ('Steven','socrates','codex','ws-prizma','dev','/home/dev','/home/dev/.local/state/cauce-v3/socrates','grp.steven','agent_notify'),
  ('Pablo','vulcano','claude','ws-pablo','dev','/home/dev','/workspace/.cauce-v3/vulcano','grp.pablo','agent'),
  ('Steven','zeus','claude','ws-zeus','dev','/home/dev','/home/dev/.local/state/cauce-v3/zeus','grp.steven','agent_notify');

CREATE TEMP TABLE fleet_029_expected_memberships (
  tenant_id text NOT NULL,
  alias text NOT NULL,
  room_id text NOT NULL,
  role text NOT NULL,
  PRIMARY KEY (tenant_id, alias, room_id)
) ON COMMIT DROP;

INSERT INTO fleet_029_expected_memberships
SELECT tenant_id,alias,room_id,membership_role FROM fleet_029_desired_agents;
INSERT INTO fleet_029_expected_memberships VALUES
  ('Steven','quota-collector','grp.steven','operator');

CREATE TEMP TABLE fleet_029_affected_identities (
  tenant_id text NOT NULL,
  alias text NOT NULL,
  PRIMARY KEY (tenant_id, alias)
) ON COMMIT DROP;

INSERT INTO fleet_029_affected_identities
SELECT tenant_id,alias FROM fleet_029_desired_agents;
INSERT INTO fleet_029_affected_identities VALUES
  ('Steven','quota-collector'),
  ('Jhon','heraclito'),
  ('Jhon','tales'),
  ('Miguel','gaia')
ON CONFLICT DO NOTHING;

-- Before images. Missing desired rows are represented by SQL NULL, not an invented empty object.
INSERT INTO fleet_reconciliation_history(run_id,entity,tenant_id,alias,previous)
SELECT run.id,'agent',identity.tenant_id,identity.alias,
       CASE WHEN agent.alias IS NULL THEN NULL ELSE jsonb_build_object(
         'harness_id',agent.harness_id,
         'enabled',agent.enabled,
         'container_name',agent.container_name,
         'runtime_user',agent.runtime_user,
         'home_directory',agent.home_directory,
         'state_directory',agent.state_directory
       ) END
  FROM fleet_029_affected_identities identity
  CROSS JOIN fleet_reconciliation_runs run
  LEFT JOIN agents agent
    ON agent.tenant_id=identity.tenant_id AND agent.alias=identity.alias
 WHERE run.active AND identity.alias <> 'quota-collector'
ON CONFLICT DO NOTHING;

INSERT INTO fleet_reconciliation_history(run_id,entity,tenant_id,alias,room_id,previous)
SELECT run.id,'membership',membership.tenant_id,membership.alias,membership.room_id,
       jsonb_build_object('role',membership.role,'enabled',membership.enabled)
  FROM memberships membership
  JOIN fleet_029_affected_identities identity
    ON identity.tenant_id=membership.tenant_id AND identity.alias=membership.alias
  CROSS JOIN fleet_reconciliation_runs run
 WHERE run.active
ON CONFLICT DO NOTHING;

INSERT INTO fleet_reconciliation_history(run_id,entity,tenant_id,alias,room_id,previous)
SELECT run.id,'membership',expected.tenant_id,expected.alias,expected.room_id,NULL
  FROM fleet_029_expected_memberships expected
  CROSS JOIN fleet_reconciliation_runs run
  LEFT JOIN memberships membership
    ON membership.tenant_id=expected.tenant_id
   AND membership.alias=expected.alias
   AND membership.room_id=expected.room_id
 WHERE run.active AND membership.alias IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO agents(
  tenant_id,alias,harness_id,display_name,enabled,
  container_name,runtime_user,home_directory,state_directory
)
SELECT tenant_id,alias,harness_id,initcap(alias),true,
       container_name,runtime_user,home_directory,state_directory
  FROM fleet_029_desired_agents
ON CONFLICT (tenant_id,alias) DO UPDATE SET
  harness_id=EXCLUDED.harness_id,
  enabled=true,
  container_name=EXCLUDED.container_name,
  runtime_user=EXCLUDED.runtime_user,
  home_directory=EXCLUDED.home_directory,
  state_directory=EXCLUDED.state_directory,
  updated_at=now()
WHERE ROW(
  agents.harness_id,agents.enabled,agents.container_name,agents.runtime_user,
  agents.home_directory,agents.state_directory
) IS DISTINCT FROM ROW(
  EXCLUDED.harness_id,true,EXCLUDED.container_name,EXCLUDED.runtime_user,
  EXCLUDED.home_directory,EXCLUDED.state_directory
);

-- These are the measured historical extras. They remain queryable and keep every foreign key.
UPDATE agents SET enabled=false,updated_at=now()
 WHERE (tenant_id,alias) IN (('Jhon','heraclito'),('Jhon','tales'),('Miguel','gaia'))
   AND enabled;

-- For affected identities there is exactly one enabled membership: the declared room and role.
UPDATE memberships membership SET enabled=false
 WHERE EXISTS (
   SELECT 1 FROM fleet_029_affected_identities identity
    WHERE identity.tenant_id=membership.tenant_id AND identity.alias=membership.alias
 )
   AND NOT EXISTS (
     SELECT 1 FROM fleet_029_expected_memberships expected
      WHERE expected.tenant_id=membership.tenant_id
        AND expected.alias=membership.alias
        AND expected.room_id=membership.room_id
   )
   AND membership.enabled;

INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
SELECT tenant_id,room_id,alias,role,true FROM fleet_029_expected_memberships
ON CONFLICT (tenant_id,room_id,alias) DO UPDATE SET
  role=EXCLUDED.role,
  enabled=true
WHERE memberships.role IS DISTINCT FROM EXCLUDED.role OR NOT memberships.enabled;

-- Applied images power the CAS-safe down migration. Leases/epochs are intentionally absent.
UPDATE fleet_reconciliation_history history SET applied=(
  SELECT jsonb_build_object(
    'harness_id',agent.harness_id,
    'enabled',agent.enabled,
    'container_name',agent.container_name,
    'runtime_user',agent.runtime_user,
    'home_directory',agent.home_directory,
    'state_directory',agent.state_directory
  ) FROM agents agent
   WHERE agent.tenant_id=history.tenant_id AND agent.alias=history.alias
)
 WHERE history.entity='agent'
   AND EXISTS (SELECT 1 FROM fleet_reconciliation_runs run WHERE run.id=history.run_id AND run.active);

UPDATE fleet_reconciliation_history history SET applied=(
  SELECT jsonb_build_object('role',membership.role,'enabled',membership.enabled)
    FROM memberships membership
   WHERE membership.tenant_id=history.tenant_id
     AND membership.alias=history.alias
     AND membership.room_id=history.room_id
)
 WHERE history.entity='membership'
   AND EXISTS (SELECT 1 FROM fleet_reconciliation_runs run WHERE run.id=history.run_id AND run.active);

INSERT INTO audit_events(action,decision,metadata)
VALUES ('fleet.reconcile.029','info',jsonb_build_object(
  'desired_agents',15,
  'system_principals',1,
  'historical_aliases_disabled',jsonb_build_array('heraclito','tales','gaia'),
  'connection_leases_mutated',false
));
