-- CAS-safe reversal of 029_reconcile_declared_fleet.sql.
-- Rows created by 029 are disabled rather than deleted: deliveries, profiles and later history
-- must survive a code rollback. Rows changed after 029 are left untouched and counted as conflicts.

BEGIN;

-- Serialize with applyMigrations(), which owns schema_migrations under this same transaction
-- advisory lock. A manual down must not race a forward migrator or integrity-ledger write.
SELECT pg_advisory_xact_lock(783_003_003);

DO $$
BEGIN
  IF (SELECT count(*) FROM fleet_reconciliation_runs WHERE active AND completed_at IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION '029 rollback requires exactly one completed active fleet reconciliation run';
  END IF;
END $$;

-- Freeze every row this down migration compares before calculating CAS conflicts. Without this
-- table-level writer barrier, a concurrent forward update could land between the comparison and
-- the restoring UPDATE, turning the check into a TOCTOU race.
LOCK TABLE agents,memberships IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE fleet_029_rollback_conflicts(kind text PRIMARY KEY,count bigint NOT NULL)
ON COMMIT DROP;

INSERT INTO fleet_029_rollback_conflicts
SELECT 'agent',count(*) FROM (
  SELECT history.tenant_id,history.alias
    FROM fleet_reconciliation_history history
    JOIN fleet_reconciliation_runs run ON run.id=history.run_id AND run.active
    LEFT JOIN agents agent
      ON agent.tenant_id=history.tenant_id AND agent.alias=history.alias
   WHERE history.entity='agent'
     AND CASE WHEN agent.alias IS NULL THEN NULL ELSE jsonb_build_object(
       'harness_id',agent.harness_id,
       'enabled',agent.enabled,
       'container_name',agent.container_name,
       'runtime_user',agent.runtime_user,
       'home_directory',agent.home_directory,
       'state_directory',agent.state_directory
     ) END IS DISTINCT FROM history.applied
  UNION ALL
  SELECT agent.tenant_id,agent.alias
    FROM agents agent
   WHERE NOT EXISTS (
     SELECT 1
       FROM fleet_reconciliation_history history
       JOIN fleet_reconciliation_runs run ON run.id=history.run_id AND run.active
      WHERE history.entity='agent'
        AND history.tenant_id=agent.tenant_id
        AND history.alias=agent.alias
   )
) conflicts;

INSERT INTO fleet_029_rollback_conflicts
SELECT 'membership',count(*) FROM (
  SELECT history.tenant_id,history.alias,history.room_id
    FROM fleet_reconciliation_history history
    JOIN fleet_reconciliation_runs run ON run.id=history.run_id AND run.active
    LEFT JOIN memberships membership
      ON membership.tenant_id=history.tenant_id
     AND membership.alias=history.alias
     AND membership.room_id=history.room_id
   WHERE history.entity='membership'
     AND CASE WHEN membership.alias IS NULL THEN NULL ELSE
       jsonb_build_object('role',membership.role,'enabled',membership.enabled)
     END IS DISTINCT FROM history.applied
  UNION ALL
  SELECT membership.tenant_id,membership.alias,membership.room_id
    FROM memberships membership
   WHERE NOT EXISTS (
     SELECT 1
       FROM fleet_reconciliation_history history
       JOIN fleet_reconciliation_runs run ON run.id=history.run_id AND run.active
      WHERE history.entity='membership'
        AND history.tenant_id=membership.tenant_id
        AND history.alias=membership.alias
        AND history.room_id=membership.room_id
   )
) conflicts;

DO $$
DECLARE agent_conflicts bigint;
DECLARE membership_conflicts bigint;
BEGIN
  SELECT count INTO agent_conflicts FROM fleet_029_rollback_conflicts WHERE kind='agent';
  SELECT count INTO membership_conflicts FROM fleet_029_rollback_conflicts WHERE kind='membership';
  IF COALESCE(agent_conflicts,0) <> 0 OR COALESCE(membership_conflicts,0) <> 0 THEN
    RAISE EXCEPTION '029 rollback refused: CAS conflicts (agents %, memberships %)',
      COALESCE(agent_conflicts,0),COALESCE(membership_conflicts,0);
  END IF;
END $$;

-- Restore pre-existing agents only if no writer changed the fields owned by 029.
UPDATE agents agent SET
  harness_id=history.previous->>'harness_id',
  enabled=(history.previous->>'enabled')::boolean,
  container_name=history.previous->>'container_name',
  runtime_user=history.previous->>'runtime_user',
  home_directory=history.previous->>'home_directory',
  state_directory=history.previous->>'state_directory',
  updated_at=now()
 FROM fleet_reconciliation_history history
 JOIN fleet_reconciliation_runs run ON run.id=history.run_id AND run.active
 WHERE history.entity='agent' AND history.previous IS NOT NULL
   AND agent.tenant_id=history.tenant_id AND agent.alias=history.alias
   AND jsonb_build_object(
     'harness_id',agent.harness_id,
     'enabled',agent.enabled,
     'container_name',agent.container_name,
     'runtime_user',agent.runtime_user,
     'home_directory',agent.home_directory,
     'state_directory',agent.state_directory
   ) = history.applied;

-- A newly inserted agent may already own forward data, so never DELETE it during rollback.
UPDATE agents agent SET enabled=false,updated_at=now()
 FROM fleet_reconciliation_history history
 JOIN fleet_reconciliation_runs run ON run.id=history.run_id AND run.active
 WHERE history.entity='agent' AND history.previous IS NULL AND history.applied IS NOT NULL
   AND agent.tenant_id=history.tenant_id AND agent.alias=history.alias
   AND jsonb_build_object(
     'harness_id',agent.harness_id,
     'enabled',agent.enabled,
     'container_name',agent.container_name,
     'runtime_user',agent.runtime_user,
     'home_directory',agent.home_directory,
     'state_directory',agent.state_directory
   ) = history.applied;

UPDATE memberships membership SET
  role=history.previous->>'role',
  enabled=(history.previous->>'enabled')::boolean
 FROM fleet_reconciliation_history history
 JOIN fleet_reconciliation_runs run ON run.id=history.run_id AND run.active
 WHERE history.entity='membership' AND history.previous IS NOT NULL
   AND membership.tenant_id=history.tenant_id
   AND membership.alias=history.alias
   AND membership.room_id=history.room_id
   AND jsonb_build_object('role',membership.role,'enabled',membership.enabled)=history.applied;

-- Same forward-data rule for a membership that 029 created: retain it disabled.
UPDATE memberships membership SET enabled=false
 FROM fleet_reconciliation_history history
 JOIN fleet_reconciliation_runs run ON run.id=history.run_id AND run.active
 WHERE history.entity='membership' AND history.previous IS NULL AND history.applied IS NOT NULL
   AND membership.tenant_id=history.tenant_id
   AND membership.alias=history.alias
   AND membership.room_id=history.room_id
   AND jsonb_build_object('role',membership.role,'enabled',membership.enabled)=history.applied;

INSERT INTO audit_events(action,decision,metadata)
SELECT 'fleet.rollback.029','info',jsonb_build_object(
  'agent_conflicts',(SELECT count FROM fleet_029_rollback_conflicts WHERE kind='agent'),
  'membership_conflicts',(SELECT count FROM fleet_029_rollback_conflicts WHERE kind='membership'),
  'rows_deleted',0,
  'connection_leases_mutated',false
);

UPDATE fleet_reconciliation_runs
   SET active=false,rolled_back_at=now()
 WHERE active;

DELETE FROM schema_migrations WHERE version='029_reconcile_declared_fleet.sql';

COMMIT;
