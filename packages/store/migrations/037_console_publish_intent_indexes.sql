-- The console publish-intent journal is durable state in audit_events.  These expression indexes
-- keep key/nonce lookup and latest bounded-head lookup independent of an actor's lifetime
-- audit history.  Predicates use literal internal action names so PostgreSQL can prove partial-
-- index eligibility even after a prepared statement switches to a generic plan.

SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_008);
LOCK TABLE audit_events IN SHARE ROW EXCLUSIVE MODE;

-- This state machine has never been deployed. Refuse to guess a head for experimental rows.
-- Runtime rollback retains additive schema 037; destructive down/up is intentionally available
-- only before the first journal write, so every forward application has one reproducible gate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_events WHERE action LIKE 'console.publish.%') THEN
    RAISE EXCEPTION 'schema 037 requires an empty console publish-intent journal';
  END IF;
END
$$;

CREATE INDEX audit_events_console_publish_key_037_idx
  ON audit_events (
    tenant_id,
    actor_alias,
    (metadata->>'idempotency_key'),
    id
  )
  WHERE action IN (
    'console.publish.prepare',
    'console.publish.confirm',
    'console.publish.expire'
  );

CREATE INDEX audit_events_console_publish_nonce_037_idx
  ON audit_events (
    tenant_id,
    actor_alias,
    (metadata->>'operator_scope_hash'),
    (metadata->>'intent_nonce_hash'),
    id DESC
  )
  WHERE action='console.publish.prepare';

CREATE INDEX audit_events_console_publish_rate_037_idx
  ON audit_events (
    tenant_id,
    actor_alias,
    (metadata->>'operator_scope_hash'),
    created_at DESC,
    id DESC
  )
  WHERE action='console.publish.prepare';

CREATE INDEX audit_events_console_publish_head_037_idx
  ON audit_events (
    tenant_id,
    actor_alias,
    (metadata->>'operator_scope_hash'),
    (metadata->>'conversation_hash'),
    id DESC
  )
  WHERE action='console.publish.head';
