-- Downgrade is safe only after every claimed PTY session has been drained and while no later
-- schema exists.  Production rollback should normally use a runtime accredited for additive
-- schema 032; this destructive inverse exists for isolated rollback verification.

SELECT pg_advisory_xact_lock(783_003_003);

-- The drain guard and the destructive ALTER are one indivisible observation. Without this lock,
-- a writer can insert/take a claim after the guard reads an empty set while ALTER waits for that
-- same writer, and the downgrade would then erase a live ownership fence.
LOCK TABLE terminal_sessions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM schema_migrations
     WHERE version > '032_terminal_session_claim_fencing.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 032 while a later migration is present';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM terminal_sessions
     WHERE relay_claim_epoch > 0
       AND closed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 032 while a claimed terminal session remains open';
  END IF;
END
$$;

ALTER TABLE terminal_sessions
  DROP CONSTRAINT IF EXISTS terminal_sessions_relay_claim_shape,
  DROP COLUMN IF EXISTS relay_claim_expires_at,
  DROP COLUMN IF EXISTS relay_claimed_at,
  DROP COLUMN IF EXISTS relay_claim_epoch,
  DROP COLUMN IF EXISTS relay_claim_sha256;

DELETE FROM schema_migrations
 WHERE version='032_terminal_session_claim_fencing.sql';
