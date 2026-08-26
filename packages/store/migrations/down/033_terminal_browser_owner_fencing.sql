-- Destructive downgrade is allowed only while 033 contains backfill-equivalent history.  Once a
-- real admission used a distinct request id or ownership rotated, dropping these columns would
-- erase the only causal fence and is refused.  Runtime rollback should retain this additive
-- schema, which older code can safely ignore.

-- Enter the same global migration critical section as applyMigrations() before taking the
-- browser-owner-specific lock.  A manual down must never tear schema down while a forward runner
-- is inspecting schema_migrations or applying a later migration.
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_004);
LOCK TABLE terminal_sessions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version>'033_terminal_browser_owner_fencing.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 033 while a later migration is present';
  END IF;

  IF EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE closed_at IS NULL AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 033 while a browser-owned terminal session remains open';
  END IF;

  IF EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE request_id IS DISTINCT FROM id
        OR request_sha256 IS DISTINCT FROM ticket_sha256
        OR browser_owner_sha256 IS DISTINCT FROM ticket_sha256
        OR browser_owner_generation<>1
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 033 after browser ownership history has been recorded';
  END IF;
END
$$;

DROP INDEX terminal_sessions_request_id_idx;

ALTER TABLE terminal_sessions
  DROP CONSTRAINT terminal_sessions_browser_owner_shape,
  DROP COLUMN browser_owner_generation,
  DROP COLUMN browser_owner_sha256,
  DROP COLUMN request_sha256,
  DROP COLUMN request_id;

DELETE FROM schema_migrations
 WHERE version='033_terminal_browser_owner_fencing.sql';
