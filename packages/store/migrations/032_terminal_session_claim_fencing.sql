-- Fence every PTY relay ownership generation independently from the durable terminal session.
--
-- A browser continuity receipt is not ownership: only the relay process which currently holds
-- the local TerminalSession may renew the exact claim.  PostgreSQL stores only SHA-256 of the
-- capability-like UUID; the raw claim remains in relay/browser memory and the relay's 0600 close
-- spool.  `relay_claim_epoch` rotates after every expired-lease takeover, including takeover with
-- the same raw claim, so a delayed close from an earlier generation can never close its successor.

ALTER TABLE terminal_sessions
  ADD COLUMN relay_claim_sha256 bytea,
  ADD COLUMN relay_claim_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN relay_claimed_at timestamptz,
  ADD COLUMN relay_claim_expires_at timestamptz;

ALTER TABLE terminal_sessions
  ADD CONSTRAINT terminal_sessions_relay_claim_shape CHECK (
    (
      relay_claim_sha256 IS NULL
      AND relay_claim_epoch = 0
      AND relay_claimed_at IS NULL
      AND relay_claim_expires_at IS NULL
    )
    OR
    (
      consumed_at IS NOT NULL
      AND relay_claim_sha256 IS NOT NULL
      AND octet_length(relay_claim_sha256) = 32
      AND relay_claim_epoch > 0
      AND relay_claimed_at IS NOT NULL
      AND relay_claim_expires_at IS NOT NULL
      AND relay_claim_expires_at > relay_claimed_at
    )
  );

COMMENT ON COLUMN terminal_sessions.relay_claim_sha256 IS
  'SHA-256 of the current capability-like relay ownership claim; raw UUID is never stored in PostgreSQL.';
COMMENT ON COLUMN terminal_sessions.relay_claim_epoch IS
  'Monotonic PTY ownership generation. Exact digest+epoch fences renew, resume and close.';
COMMENT ON COLUMN terminal_sessions.relay_claim_expires_at IS
  'PostgreSQL-clock lease deadline. Takeover rotates epoch only after this instant.';
