-- Durable OIDC BFF sessions and fail-closed Telegram egress recovery.
-- This migration is additive for databases already running 005 and is also safe on a fresh install.

-- A row left in sending cannot be replayed automatically: Telegram may have accepted the
-- request before the worker lost its local confirmation. Keep the diagnosis and manual replay
-- audit in the migration-owned schema rather than mutating DDL from a runtime worker.
ALTER TABLE telegram_egress_effects
  ADD COLUMN IF NOT EXISTS chunk_count integer,
  ADD COLUMN IF NOT EXISTS diagnostic text,
  ADD COLUMN IF NOT EXISTS diagnosed_at timestamptz,
  ADD COLUMN IF NOT EXISTS replay_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replayed_at timestamptz;

WITH chunk_counts AS (
  SELECT outbox_id, max(chunk_index) + 1 AS chunk_count
  FROM telegram_egress_effects
  GROUP BY outbox_id
)
UPDATE telegram_egress_effects effect
SET chunk_count=counts.chunk_count
FROM chunk_counts counts
WHERE effect.outbox_id=counts.outbox_id AND effect.chunk_count IS NULL;

ALTER TABLE telegram_egress_effects
  ALTER COLUMN chunk_count SET NOT NULL,
  DROP CONSTRAINT IF EXISTS telegram_egress_effects_state_check,
  DROP CONSTRAINT IF EXISTS telegram_egress_effects_chunk_count_check,
  DROP CONSTRAINT IF EXISTS telegram_egress_effects_chunk_coordinates_check,
  DROP CONSTRAINT IF EXISTS telegram_egress_effects_payload_hash_check;

ALTER TABLE telegram_egress_effects
  ADD CONSTRAINT telegram_egress_effects_state_check
    CHECK (state IN ('prepared','sending','sent','ambiguous','dead')),
  ADD CONSTRAINT telegram_egress_effects_chunk_count_check
    CHECK (chunk_count > 0),
  ADD CONSTRAINT telegram_egress_effects_chunk_coordinates_check
    CHECK (chunk_index < chunk_count),
  ADD CONSTRAINT telegram_egress_effects_payload_hash_check
    CHECK (payload_hash ~ '^[a-f0-9]{64}$') NOT VALID;

ALTER TABLE telegram_egress_effects
  VALIDATE CONSTRAINT telegram_egress_effects_payload_hash_check;

-- The browser receives opaque random handles only. Record keys are one-way SHA-256 digests and
-- payloads are AES-256-GCM ciphertext authenticated by the gateway before JSON decoding.
CREATE TABLE IF NOT EXISTS gateway_oidc_sessions (
  kind text NOT NULL,
  key_hash bytea NOT NULL,
  encrypted_payload bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT gateway_oidc_sessions_pkey PRIMARY KEY (kind,key_hash),
  CONSTRAINT gateway_oidc_sessions_kind_check CHECK (kind IN ('login','session')),
  CONSTRAINT gateway_oidc_sessions_key_hash_check CHECK (octet_length(key_hash)=32)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='gateway_oidc_sessions'::regclass
      AND conname='gateway_oidc_sessions_payload_check'
  ) THEN
    ALTER TABLE gateway_oidc_sessions
      ADD CONSTRAINT gateway_oidc_sessions_payload_check
      CHECK (octet_length(encrypted_payload)>=29) NOT VALID;
  END IF;
END
$$;

ALTER TABLE gateway_oidc_sessions
  VALIDATE CONSTRAINT gateway_oidc_sessions_payload_check;

CREATE INDEX IF NOT EXISTS gateway_oidc_sessions_expiry_idx
  ON gateway_oidc_sessions(expires_at);
