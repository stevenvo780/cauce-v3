-- Browser admission idempotency and revocation ownership are different concerns.
--
-- `request_id` identifies one semantic admission across lost HTTP 201 responses.  Its retries
-- must present the same raw owner capability; PostgreSQL keeps only its SHA-256 digest. Explicit
-- operator takeover is the sole transition which advances `browser_owner_generation`, so a
-- delayed DELETE can never revoke a generation adopted by that takeover.

SELECT pg_advisory_xact_lock(783_003_004);

ALTER TABLE terminal_sessions
  ADD COLUMN request_id uuid,
  ADD COLUMN request_sha256 bytea,
  ADD COLUMN browser_owner_sha256 bytea,
  ADD COLUMN browser_owner_generation bigint;

-- Historical rows predate browser fencing.  `id` is already a canonical UUID and ticket_sha256
-- is a 32-byte non-secret digest, so this backfill makes them internally valid without inventing
-- or storing any raw capability.  A browser must rotate ownership before it can revoke one.
UPDATE terminal_sessions
   SET request_id=id,
       request_sha256=ticket_sha256,
       browser_owner_sha256=ticket_sha256,
       browser_owner_generation=1
 WHERE request_id IS NULL
    OR request_sha256 IS NULL
    OR browser_owner_sha256 IS NULL
    OR browser_owner_generation IS NULL;

ALTER TABLE terminal_sessions
  ALTER COLUMN request_id SET NOT NULL,
  ALTER COLUMN request_sha256 SET NOT NULL,
  ALTER COLUMN browser_owner_sha256 SET NOT NULL,
  ALTER COLUMN browser_owner_generation SET NOT NULL,
  ADD CONSTRAINT terminal_sessions_browser_owner_shape CHECK (
    octet_length(request_sha256)=32
    AND octet_length(browser_owner_sha256)=32
    AND browser_owner_generation>0
  );

CREATE UNIQUE INDEX terminal_sessions_request_id_idx
  ON terminal_sessions(request_id);

COMMENT ON COLUMN terminal_sessions.request_id IS
  'Stable client admission UUID. Recovery is permitted only for this id and exact immutable request semantics.';
COMMENT ON COLUMN terminal_sessions.request_sha256 IS
  'Canonical SHA-256 of request id, authenticated actor/operator and immutable target/admission semantics.';
COMMENT ON COLUMN terminal_sessions.browser_owner_sha256 IS
  'SHA-256 of the current browser revocation capability. Raw capability exists only on the wire and in browser memory.';
COMMENT ON COLUMN terminal_sessions.browser_owner_generation IS
  'Monotonic browser ownership fence. Only explicit operator takeover rotates it; DELETE requires exact digest plus generation.';
