-- Pin every browser ticket and PTY ownership generation to an authenticated relay instance.
--
-- `relay_instance_id` is SHA-256 of the DER leaf certificate presented by terminal-relay to the
-- gateway.  The gateway recomputes it from the TLS peer; a request body is never authority.
-- `relay_boot_id` distinguishes concurrent processes which accidentally share that certificate.
-- Historical closed/revoked rows may remain NULL because inventing an identity would corrupt the
-- audit trail.  Every usable post-034 row is pinned before a ticket is emitted.

SELECT pg_advisory_xact_lock(783_003_005);

-- The empty-plane preflight and ALTER are one observation. Otherwise a pre-034 writer could
-- insert a usable unpinned ticket after the guard while ALTER waits for the writer to finish.
LOCK TABLE terminal_sessions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM terminal_sessions
     WHERE closed_at IS NULL AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot apply schema 034 while an unpinned terminal session remains usable';
  END IF;
END
$$;

ALTER TABLE terminal_sessions
  ADD COLUMN relay_instance_id text,
  ADD COLUMN relay_boot_id uuid;

ALTER TABLE terminal_sessions
  ADD CONSTRAINT terminal_sessions_relay_instance_shape CHECK (
    (
      relay_instance_id IS NULL
      AND relay_boot_id IS NULL
      AND (closed_at IS NOT NULL OR revoked_at IS NOT NULL)
    )
    OR
    (
      relay_instance_id IS NOT NULL
      AND relay_instance_id ~ '^[0-9a-f]{64}$'
      AND (
        (relay_claim_epoch=0 AND relay_boot_id IS NULL)
        OR
        (
          relay_claim_epoch>0
          AND relay_boot_id IS NOT NULL
          AND relay_boot_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )
      )
    )
  );

COMMENT ON COLUMN terminal_sessions.relay_instance_id IS
  'SHA-256 hex of the authenticated terminal-relay gateway-client DER leaf. Ticket and browser WebSocket route are pinned to it.';
COMMENT ON COLUMN terminal_sessions.relay_boot_id IS
  'UUIDv4 process generation holding the current relay claim. NULL only before consume or on legacy closed/revoked history.';
