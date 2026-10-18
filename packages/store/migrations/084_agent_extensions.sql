SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_084);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE agents,fleet_hosts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE agents ADD COLUMN extensions jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(extensions)='array');
ALTER TABLE fleet_hosts ADD COLUMN extensions_allowed jsonb NOT NULL
  DEFAULT '{"types":[],"mount_roots":[],"networks":[]}'::jsonb
  CHECK (jsonb_typeof(extensions_allowed)='object'
    AND extensions_allowed ?& ARRAY['types','mount_roots','networks']
    AND jsonb_typeof(extensions_allowed->'types')='array'
    AND jsonb_typeof(extensions_allowed->'mount_roots')='array'
    AND jsonb_typeof(extensions_allowed->'networks')='array');

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
