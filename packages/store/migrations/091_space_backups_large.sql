SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_060);
SELECT pg_advisory_xact_lock(783_003_091);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);

ALTER TABLE space_backups
  DROP CONSTRAINT space_backups_received_bytes_check,
  DROP CONSTRAINT space_backups_bytes_check,
  ALTER COLUMN received_bytes TYPE bigint,
  ALTER COLUMN bytes TYPE bigint;
ALTER TABLE space_backups
  ADD CONSTRAINT space_backups_received_bytes_check CHECK (received_bytes BETWEEN 0 AND 17255366656),
  ADD CONSTRAINT space_backups_bytes_check CHECK (bytes BETWEEN 1 AND 17255366656);

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
