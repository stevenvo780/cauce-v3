SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_047);
LOCK TABLE fleet_operation_events,fleet_operations,fleet_runtime_identities,agents,tenants,rooms,memberships IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>'047_ui_fleet_lifecycle.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 047 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_operations) OR EXISTS (SELECT 1 FROM fleet_operation_events)
     OR EXISTS (SELECT 1 FROM fleet_runtime_identities WHERE NOT baseline)
     OR EXISTS (SELECT 1 FROM fleet_runtime_identities identity
       LEFT JOIN agents agent ON agent.tenant_id=identity.tenant_id AND agent.alias=identity.alias
       WHERE identity.baseline AND (agent.alias IS NULL OR identity.baseline_state IS DISTINCT FROM jsonb_build_object(
         'primary_room_id',agent.primary_room_id,'lifecycle_state',agent.lifecycle_state,
         'runtime_mode',agent.runtime_mode,'systemd_user',agent.systemd_user,'host_id',agent.host_id,
         'primary_account_id',agent.primary_account_id,'model_id',agent.model_id)))
     OR EXISTS (SELECT 1 FROM agents WHERE retired_at IS NOT NULL OR host_id IS NOT NULL OR primary_account_id IS NOT NULL OR model_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM tenants WHERE retired_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM rooms WHERE retired_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM memberships WHERE retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback preserves fleet history; populated lifecycle schema cannot be removed';
  END IF;
END;
$$;
DROP TRIGGER agent_runtime_key_reservation ON agents;
DROP FUNCTION reserve_agent_runtime_key();
DROP TABLE fleet_operation_events;
DROP TABLE fleet_operations;
DROP TABLE fleet_runtime_identities;
DROP FUNCTION preserve_fleet_operation_history();
DROP FUNCTION preserve_fleet_runtime_identity();
ALTER TABLE agents DROP CONSTRAINT agents_primary_room_membership, DROP CONSTRAINT agents_retirement_admission,
  DROP COLUMN runtime_key, DROP COLUMN primary_room_id, DROP COLUMN host_id, DROP COLUMN runtime_mode,
  DROP COLUMN systemd_user, DROP COLUMN primary_account_id, DROP COLUMN model_id,
  DROP COLUMN lifecycle_state, DROP COLUMN retired_at;
ALTER TABLE tenants DROP CONSTRAINT tenants_retirement_admission, DROP COLUMN retired_at, DROP COLUMN retired_enabled;
ALTER TABLE rooms DROP CONSTRAINT rooms_retirement_admission, DROP COLUMN retired_at, DROP COLUMN retired_enabled;
ALTER TABLE memberships DROP CONSTRAINT memberships_retirement_admission, DROP COLUMN retired_at, DROP COLUMN retired_enabled;
DELETE FROM schema_migration_ledger WHERE version='047_ui_fleet_lifecycle.sql';
DELETE FROM schema_migrations WHERE version='047_ui_fleet_lifecycle.sql';
