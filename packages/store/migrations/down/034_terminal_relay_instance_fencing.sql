-- Destructive downgrade is safe only before schema-034 has admitted any pinned session. Runtime
-- rollback should retain the additive columns; this inverse exists for isolated rollback proof.

-- Lock order is global migration fence first, then the relay-instance fence.  This matches every
-- forward migrator and prevents a successful down from racing a concurrent applyMigrations().
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_005);
LOCK TABLE terminal_sessions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version>'034_terminal_relay_instance_fencing.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 034 while a later migration is present';
  END IF;

  IF EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE closed_at IS NULL AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 034 while a terminal session remains usable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE relay_instance_id IS NOT NULL OR relay_boot_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 034 after relay routing history has been recorded';
  END IF;
END
$$;

ALTER TABLE terminal_sessions
  DROP CONSTRAINT terminal_sessions_relay_instance_shape,
  DROP COLUMN relay_boot_id,
  DROP COLUMN relay_instance_id;

DELETE FROM schema_migrations
 WHERE version='034_terminal_relay_instance_fencing.sql';
