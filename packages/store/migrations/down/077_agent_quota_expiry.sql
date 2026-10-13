SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_077);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'077_agent_quota_expiry.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'077_agent_quota_expiry.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 077 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='077_agent_quota_expiry.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='077_agent_quota_expiry.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='077_agent_quota_expiry.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'0221f690eb5ae12f25b10e2cc538716f88e29a7b746045c0c47e5ea1b5289047'))
    OR (EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.agent_quota_operations'::regclass
      AND attname='expires_at' AND NOT attisdropped)
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='077_agent_quota_expiry.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 077 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE agent_quota_operations IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_quota_operations WHERE status IN ('pending','running') OR error_code='EXPIRED') THEN
    RAISE EXCEPTION 'resolve active or expired agent quota operations before reverting';
  END IF;
END
$$;
ALTER TABLE agent_quota_operations DROP CONSTRAINT agent_quota_operations_error_code_check;
ALTER TABLE agent_quota_operations ADD CONSTRAINT agent_quota_operations_error_code_check
  CHECK (error_code IN ('PROVIDER_UNAVAILABLE','RUNTIME_UNAVAILABLE','STEP_FAILED','AUTHORITY_REVOKED','SCOPE_CHANGED'));
ALTER TABLE agent_quota_operations DROP COLUMN IF EXISTS expires_at;
DELETE FROM schema_migration_ledger WHERE version='077_agent_quota_expiry.sql';
DELETE FROM schema_migrations WHERE version='077_agent_quota_expiry.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
