-- Reversible only while no later schema exists.  Dropping this column deliberately invalidates
-- the connection-token-aware runtime, so production rollback must first select an accredited
-- bridge compatible with schema 031 rather than running this file in place.

SELECT pg_advisory_xact_lock(783_003_003);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM schema_migrations
     WHERE version > '031_connection_session_fencing.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 031 while a later migration is present';
  END IF;
END
$$;

ALTER TABLE connection_leases
  DROP COLUMN IF EXISTS connection_token;

DELETE FROM schema_migrations
 WHERE version='031_connection_session_fencing.sql';
