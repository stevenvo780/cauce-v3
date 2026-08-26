-- An old shadow worker cannot distinguish an unstarted processing lease after this column is
-- removed. Downgrade is therefore safe only with the inbox fully drained of processing claims.

-- The shared migration lock must be acquired before the shadow-phase lock.  Keeping this order
-- identical to the forward runner closes the down/apply race without introducing lock inversion.
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_007);
LOCK TABLE shadow_router_inbox IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version>'036_shadow_router_target_phase.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 036 while a later migration is present';
  END IF;

  IF EXISTS (SELECT 1 FROM shadow_router_inbox WHERE status='processing') THEN
    RAISE EXCEPTION 'cannot downgrade schema 036 while shadow leases are processing';
  END IF;
END
$$;

DROP TRIGGER shadow_router_inbox_claim_phase_transition ON shadow_router_inbox;
DROP FUNCTION cauce_shadow_router_claim_phase_transition();
DROP TRIGGER shadow_router_mapping_status_monotonic ON shadow_router_mappings;
DROP FUNCTION cauce_shadow_router_mapping_status_monotonic();
DROP TRIGGER shadow_router_mapping_terminal_reconcile ON shadow_router_mappings;
DROP FUNCTION cauce_shadow_router_mapping_terminal_reconcile();

ALTER TABLE shadow_router_inbox
  DROP CONSTRAINT shadow_router_inbox_claim_phase_shape,
  DROP COLUMN claim_target_started;

DELETE FROM schema_migrations
 WHERE version='036_shadow_router_target_phase.sql';
