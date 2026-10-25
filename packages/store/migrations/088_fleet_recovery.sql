SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_088);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);

ALTER TABLE fleet_operations DROP CONSTRAINT fleet_operations_kind_check;
ALTER TABLE fleet_operations ADD CONSTRAINT fleet_operations_kind_check
  CHECK (kind IN ('create','update','start','stop','retire','restore','purge','recover'));

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
