SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_077);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
ALTER TABLE agent_quota_operations ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes';
ALTER TABLE agent_quota_operations DROP CONSTRAINT agent_quota_operations_error_code_check;
ALTER TABLE agent_quota_operations ADD CONSTRAINT agent_quota_operations_error_code_check
  CHECK (error_code IN ('PROVIDER_UNAVAILABLE','RUNTIME_UNAVAILABLE','STEP_FAILED','AUTHORITY_REVOKED','SCOPE_CHANGED','EXPIRED'));
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
