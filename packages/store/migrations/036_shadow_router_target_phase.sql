-- Shadow attempts are consumed only when the worker durably observes target settlement.
-- `claim_target_started` is an armed-dispatch fence, not proof that external I/O happened: an
-- expired armed lease with no terminal mapping is replayed idempotently with target_event_id.
--
-- The pre-036 runtime eagerly increments attempts at claim time and cannot distinguish failures
-- before target I/O. Safe expand/contract coexistence is therefore impossible. Migration 036 is an
-- explicit stop/drain interlock: no processing lease may cross it, and its trigger rejects every
-- eager pre-036 claim after commit. Rollout and rollback must stop the worker, drain, migrate, then
-- start the matching binary.

SELECT pg_advisory_xact_lock(783_003_007);
LOCK TABLE shadow_router_inbox IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shadow_router_inbox WHERE status='processing') THEN
    RAISE EXCEPTION 'schema 036 requires shadow workers stopped and processing leases drained';
  END IF;
END
$$;

ALTER TABLE shadow_router_inbox
  ADD COLUMN claim_target_started boolean NOT NULL DEFAULT false;

-- Old versions left ownership columns populated on some non-processing rows. There are no
-- processing rows past the drain gate, so normalize the complete row shape before adding CHECK.
UPDATE shadow_router_inbox
   SET claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,claim_target_started=false;

-- Repair historical false DLQ/readiness state from the old split transaction. A terminal mapping
-- proves routing completed. `blocked` specifically proves no target invocation, so restore the one
-- eager claim increment; successful target mappings retain their already-consumed attempt. The
-- blocked marker survives down/up and prevents applying the repair twice.
UPDATE shadow_router_inbox inbox
   SET status='done',
       attempts=CASE
         WHEN mapping.status='blocked'
           AND inbox.last_error IS DISTINCT FROM
             'shadow accounting v036: blocked mapping proves target was not invoked'
           THEN GREATEST(inbox.attempts-1,0)
         ELSE inbox.attempts
       END,
       completed_at=COALESCE(inbox.completed_at,mapping.updated_at,clock_timestamp()),
       claimed_by=NULL,
       claim_token=NULL,
       claim_expires_at=NULL,
       claim_target_started=false,
       last_error=CASE
         WHEN mapping.status='blocked'
           THEN 'shadow accounting v036: blocked mapping proves target was not invoked'
         ELSE NULL
       END
  FROM shadow_router_mappings mapping
 WHERE mapping.direction=inbox.direction
   AND mapping.source_event_id=inbox.source_event_id
   AND mapping.status IN ('shadowed','compared','delivered','blocked')
   AND (
     inbox.status<>'done'
     OR (
       mapping.status='blocked'
       AND inbox.last_error IS DISTINCT FROM
         'shadow accounting v036: blocked mapping proves target was not invoked'
     )
   );

-- Every pre-036 failed/dead row without terminal proof is inherently ambiguous: all of its eager
-- claims may have failed before target I/O. No individual old attempt has durable evidence, so
-- restore full capacity. Runtime 036 leaves internal last_error markers for observed settlement or
-- explicitly unconsumed leases; those markers survive a drained down/up and protect new accounting.
UPDATE shadow_router_inbox inbox
   SET status='pending',
       attempts=0,
       available_at=now(),
       completed_at=NULL,
       last_error='schema 036 reset unverifiable eager attempt history'
 WHERE inbox.status IN ('failed','dead')
   AND NOT COALESCE((
     inbox.last_error LIKE 'shadow target settlement observed:%'
     OR inbox.last_error LIKE 'shadow inbox lease released before target dispatch:%'
     OR inbox.last_error='shadow target dispatch outcome was lost; replaying idempotently'
     OR inbox.last_error='shadow inbox lease expired before target dispatch'
   ),false)
   AND NOT EXISTS (
     SELECT 1 FROM shadow_router_mappings mapping
      WHERE mapping.direction=inbox.direction
        AND mapping.source_event_id=inbox.source_event_id
        AND mapping.status IN ('shadowed','compared','delivered','blocked')
   );

ALTER TABLE shadow_router_inbox
  ADD CONSTRAINT shadow_router_inbox_claim_phase_shape CHECK (
    (
      status='processing'
      AND claimed_by IS NOT NULL
      AND claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL
    ) OR (
      status<>'processing'
      AND claimed_by IS NULL
      AND claim_token IS NULL
      AND claim_expires_at IS NULL
      AND claim_target_started=false
    )
  );

CREATE FUNCTION cauce_shadow_router_claim_phase_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('pending','failed') AND NEW.status='processing' THEN
    IF OLD.attempts>=OLD.max_attempts
       OR NEW.attempts<>OLD.attempts
       OR NEW.claim_target_started THEN
      RAISE EXCEPTION 'shadow claim must enter processing before consuming its target attempt'
        USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
    END IF;
  ELSIF OLD.status NOT IN ('pending','failed','processing') AND NEW.status='processing' THEN
    RAISE EXCEPTION 'terminal shadow inbox state cannot be claimed'
      USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
  ELSIF OLD.status='processing' AND NEW.status='processing' THEN
    IF NEW.attempts<>OLD.attempts
       OR NEW.max_attempts<>OLD.max_attempts
       OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
       OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
       OR (OLD.claim_target_started AND NOT NEW.claim_target_started) THEN
      RAISE EXCEPTION 'processing shadow lease phase or ownership is fenced'
        USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
    END IF;
    IF NOT OLD.claim_target_started AND NEW.claim_target_started
       AND NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at THEN
      RAISE EXCEPTION 'shadow target start cannot replace its lease expiry'
        USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
    END IF;
  ELSIF OLD.status='processing' AND NEW.status<>'processing' THEN
    IF NEW.max_attempts<>OLD.max_attempts THEN
      RAISE EXCEPTION 'shadow lease settlement cannot rewrite max attempts'
        USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
    END IF;

    IF NEW.status='done' AND EXISTS (
      SELECT 1 FROM shadow_router_mappings mapping
       WHERE mapping.direction=OLD.direction
         AND mapping.source_event_id=OLD.source_event_id
         AND mapping.status IN ('shadowed','compared','delivered','blocked')
    ) THEN
      IF NEW.attempts NOT IN (OLD.attempts, OLD.attempts+1)
         OR NEW.attempts>NEW.max_attempts THEN
        RAISE EXCEPTION 'terminal mapping reconciliation has invalid attempt accounting'
          USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
      END IF;
    ELSIF NOT OLD.claim_target_started THEN
      IF NEW.attempts<>OLD.attempts OR NEW.status NOT IN ('pending','failed','done') THEN
        RAISE EXCEPTION 'unstarted shadow lease settlement consumed an attempt'
          USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
      END IF;
    ELSIF NEW.attempts=OLD.attempts THEN
      IF NEW.status NOT IN ('pending','failed') THEN
        RAISE EXCEPTION 'ambiguous target dispatch may only be replayed without an attempt'
          USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
      END IF;
    ELSIF NEW.attempts=OLD.attempts+1 THEN
      IF NEW.attempts>NEW.max_attempts OR NEW.status NOT IN ('done','failed','dead') THEN
        RAISE EXCEPTION 'observed target settlement has invalid attempt accounting'
          USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
      END IF;
    ELSE
      RAISE EXCEPTION 'target settlement must consume at most its one prospective attempt'
        USING ERRCODE='23514', CONSTRAINT='shadow_router_inbox_claim_phase_transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shadow_router_inbox_claim_phase_transition
BEFORE UPDATE ON shadow_router_inbox
FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_claim_phase_transition();

-- Competing leases share the same durable mapping/idempotency key. A late failure from lease B
-- must never overwrite terminal success already committed by expired lease A.
CREATE FUNCTION cauce_shadow_router_mapping_status_monotonic()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('shadowed','compared','delivered','blocked')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status := OLD.status;
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shadow_router_mapping_status_monotonic
BEFORE UPDATE OF status ON shadow_router_mappings
FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_mapping_status_monotonic();

-- Reconcile mapping success to inbox in the same transaction. This closes both orderings of the
-- expired-A/live-B race: if B settles first, A later repairs failed/dead; if A settles first,
-- mapping-aware B observes terminal state. A released, unstarted B lease leaves a durable
-- last_error prefix so a late A terminal mapping can consume A's still-unaccounted logical
-- attempt. `blocked` never consumes an attempt.
CREATE FUNCTION cauce_shadow_router_mapping_terminal_reconcile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('shadowed','compared','delivered','blocked') THEN
    UPDATE shadow_router_inbox inbox
       SET status='done',
           attempts=LEAST(inbox.max_attempts,inbox.attempts+CASE
             WHEN NEW.status='blocked' THEN 0
             WHEN inbox.status='processing' THEN 1
             WHEN inbox.status='pending' THEN 1
            WHEN inbox.status='failed'
               AND (
                 inbox.last_error='shadow target dispatch outcome was lost; replaying idempotently'
                 OR inbox.last_error LIKE 'shadow inbox lease released before target dispatch:%'
               )
               THEN 1
             ELSE 0
           END),
           completed_at=COALESCE(inbox.completed_at,clock_timestamp()),
           claimed_by=NULL,
           claim_token=NULL,
           claim_expires_at=NULL,
           claim_target_started=false,
           last_error=CASE
             WHEN NEW.status='blocked'
               THEN 'shadow accounting v036: blocked mapping proves target was not invoked'
             ELSE NULL
           END
     WHERE inbox.direction=NEW.direction
       AND inbox.source_event_id=NEW.source_event_id
       AND inbox.status<>'done';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER shadow_router_mapping_terminal_reconcile
AFTER INSERT OR UPDATE ON shadow_router_mappings
FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_mapping_terminal_reconcile();

COMMENT ON COLUMN shadow_router_inbox.claim_target_started IS
  'Current fenced lease armed target dispatch; an unobserved outcome is replayed idempotently.';
