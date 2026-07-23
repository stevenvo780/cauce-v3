-- Upgrade path for databases that applied an earlier pre-release 001 migration.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS consumer_instance_id text;
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check
  CHECK (status IN ('pending','leased','accepted','started','done','failed','retry','dead'));

DROP INDEX IF EXISTS deliveries_inflight_idx;
CREATE INDEX deliveries_inflight_idx ON deliveries (claim_expires_at, claimed_at)
  WHERE status IN ('leased','accepted','started');

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE dead_letters ALTER COLUMN delivery_id DROP NOT NULL;
ALTER TABLE dead_letters ADD COLUMN IF NOT EXISTS job_id uuid UNIQUE REFERENCES jobs(id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dead_letters'::regclass
      AND conname = 'dead_letters_exactly_one_target'
  ) THEN
    ALTER TABLE dead_letters ADD CONSTRAINT dead_letters_exactly_one_target
      CHECK (num_nonnulls(delivery_id, job_id) = 1);
  END IF;
END $$;
