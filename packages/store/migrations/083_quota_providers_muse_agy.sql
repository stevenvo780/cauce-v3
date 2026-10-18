SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_083);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE quota_environments IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE quota_environments DROP CONSTRAINT quota_environments_provider_check;
ALTER TABLE quota_environments ADD CONSTRAINT quota_environments_provider_check
  CHECK (provider IN ('claude','codex','gemini','grok','muse','agy'));

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
