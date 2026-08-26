-- Fence every live transport connection independently from the durable execution epoch.
--
-- Renewable consumers deliberately keep (instance_id, epoch) across a reconnect so their
-- in-flight delivery claims remain recoverable.  That pair therefore cannot distinguish the new
-- socket from a half-open socket attached to another gateway.  connection_token is rotated by
-- acquireLease() on every successful hello and is never projected by presence/status APIs.

ALTER TABLE connection_leases
  ADD COLUMN connection_token uuid NOT NULL DEFAULT gen_random_uuid();

COMMENT ON COLUMN connection_leases.connection_token IS
  'Ephemeral per-hello fence. Rotated for every acquired/resumed connection; never an identity or execution epoch.';
