SELECT pg_advisory_xact_lock(783_003_049);

ALTER TABLE agents
  ADD COLUMN purged_at timestamptz,
  ADD COLUMN reasoning_effort text CHECK (reasoning_effort IN ('minimal','low','medium','high','xhigh','max')),
  ADD CONSTRAINT agents_purge_admission CHECK (purged_at IS NULL OR (retired_at IS NOT NULL AND NOT enabled));
ALTER TABLE rooms ADD COLUMN purged_at timestamptz,
  ADD CONSTRAINT rooms_purge_admission CHECK (purged_at IS NULL OR (retired_at IS NOT NULL AND NOT enabled));
ALTER TABLE tenants ADD COLUMN purged_at timestamptz,
  ADD CONSTRAINT tenants_purge_admission CHECK (purged_at IS NULL OR (retired_at IS NOT NULL AND NOT enabled));
