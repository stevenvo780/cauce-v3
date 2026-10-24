SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_086);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE agents IN ACCESS EXCLUSIVE MODE;

ALTER TABLE agents
  ADD COLUMN runtime_certificate_sha256 text,
  ADD COLUMN runtime_certificate_host_id text,
  ADD COLUMN runtime_certificate_expires_at timestamptz,
  ADD CONSTRAINT agents_runtime_certificate_identity CHECK (
    (runtime_certificate_sha256 IS NULL AND runtime_certificate_expires_at IS NULL)
    OR (runtime_certificate_sha256 IS NOT NULL AND runtime_certificate_sha256 ~ '^[a-f0-9]{64}$'
      AND runtime_certificate_host_id IS NOT NULL AND runtime_certificate_host_id ~ '^[a-z][a-z0-9_-]{0,63}$'
      AND runtime_certificate_expires_at IS NOT NULL AND isfinite(runtime_certificate_expires_at))
  );

UPDATE agents agent SET runtime_certificate_host_id=agent.host_id
WHERE agent.runtime_mode IS NULL AND agent.host_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM fleet_runtime_identities original WHERE original.tenant_id=agent.tenant_id
    AND original.alias=agent.alias AND original.runtime_key=agent.runtime_key AND original.baseline
    AND original.baseline_state->>'runtime_mode' IS NULL
);

SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);
