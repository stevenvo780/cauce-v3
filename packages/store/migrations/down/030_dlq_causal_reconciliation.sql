SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));

-- The precheck and teardown are one fenced critical section.  ACCESS EXCLUSIVE is deliberate:
-- every effect/audit/outbox writer already holds a PostgreSQL table lock before its row trigger
-- runs.  Waiting for those writers here, then holding the tables through COMMIT, prevents a
-- trigger from appending causal history after the precheck and before its ledger is dropped.
-- PostgreSQL queues later writers behind this lock request, so a busy queue cannot starve the
-- downgrade or slip a new write into the teardown window.
DO $$
DECLARE
  relations text;
BEGIN
  SELECT string_agg(format('%I',relation_name),',' ORDER BY relation_name)
    INTO relations
  FROM unnest(ARRAY[
    'adapter_outbox','audit_events','dead_letters','dlq_operator_resolutions',
    'dlq_reconciliation_runs','dlq_reconciliation_transitions','outbox_dead_letters',
    'telegram_egress_effects','telegram_manual_replays'
  ]) relation_name
  WHERE to_regclass(relation_name) IS NOT NULL;
  IF relations IS NOT NULL THEN
    EXECUTE 'LOCK TABLE ' || relations || ' IN ACCESS EXCLUSIVE MODE';
  END IF;
END
$$;

-- Once 030 has recorded an operator decision or a replay generation, dropping it would erase the
-- only causal/audit linkage.  A rollback bridge must preserve 030 in that case; fail closed rather
-- than silently pretending the older schema can represent the state.
DO $$
DECLARE
  has_history boolean := false;
  found_history boolean;
BEGIN
  IF to_regclass('dlq_reconciliation_transitions') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM dlq_reconciliation_transitions)' INTO found_history;
    has_history := has_history OR found_history;
  END IF;
  IF to_regclass('dlq_reconciliation_runs') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM dlq_reconciliation_runs)' INTO found_history;
    has_history := has_history OR found_history;
  END IF;
  IF to_regclass('telegram_manual_replays') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM telegram_manual_replays)' INTO found_history;
    has_history := has_history OR found_history;
  END IF;
  IF to_regclass('dlq_operator_resolutions') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM dlq_operator_resolutions)' INTO found_history;
    has_history := has_history OR found_history;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='dead_letters'
      AND column_name='disposition'
  ) THEN
    EXECUTE $history$
      SELECT EXISTS (
        SELECT 1 FROM dead_letters
        WHERE disposition<>'unclassified' OR disposition_at IS NOT NULL
           OR resolution_rule IS NOT NULL OR evidence_sha256 IS NOT NULL
      )
    $history$ INTO found_history;
    has_history := has_history OR found_history;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='outbox_dead_letters'
      AND column_name='disposition'
  ) THEN
    EXECUTE $history$
      SELECT EXISTS (
        SELECT 1 FROM outbox_dead_letters
        WHERE disposition<>'unclassified' OR disposition_at IS NOT NULL
           OR resolution_rule IS NOT NULL OR evidence_sha256 IS NOT NULL
           OR reopen_count<>0 OR last_reopened_at IS NOT NULL
      )
    $history$ INTO found_history;
    has_history := has_history OR found_history;
  END IF;
  IF has_history THEN
    RAISE EXCEPTION 'cannot downgrade schema 030 after durable DLQ reconciliation history exists';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS cauce_reopen_outbox_dead_letter_030 ON adapter_outbox;
DROP FUNCTION IF EXISTS cauce_reopen_outbox_dead_letter_030();
DROP TRIGGER IF EXISTS cauce_fence_outbox_dead_letter_030 ON outbox_dead_letters;
DROP FUNCTION IF EXISTS cauce_fence_outbox_dead_letter_030();
DROP TRIGGER IF EXISTS cauce_fence_dead_letter_030 ON dead_letters;
DROP FUNCTION IF EXISTS cauce_fence_dead_letter_030();
DROP TRIGGER IF EXISTS cauce_fence_adapter_outbox_causality_030 ON adapter_outbox;
DROP FUNCTION IF EXISTS cauce_fence_adapter_outbox_causality_030();
DROP TRIGGER IF EXISTS cauce_fence_telegram_effect_030 ON telegram_egress_effects;
DROP FUNCTION IF EXISTS cauce_fence_telegram_effect_030();
DROP TRIGGER IF EXISTS cauce_fence_dlq_delivery_evidence_030 ON audit_events;
DROP FUNCTION IF EXISTS cauce_fence_dlq_delivery_evidence_030();
DROP FUNCTION IF EXISTS cauce_reconcile_telegram_terminal_030(text);
DROP FUNCTION IF EXISTS cauce_list_dlq_030(text,text,integer,text);
DROP FUNCTION IF EXISTS cauce_list_dlq_030(text,text,integer);
DROP FUNCTION IF EXISTS cauce_resolve_dlq_without_replay_030(text,uuid,text,text,text,text,boolean,boolean);
DROP FUNCTION IF EXISTS cauce_inspect_telegram_replay_030(uuid,text,text,text);
DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,text,text,text,text,boolean,uuid);
DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,text,text,text,text,boolean,uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,text,text,text,boolean,uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,integer,text,text,text,boolean,uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS cauce_manual_replay_telegram_030(text,text,text,text,text,boolean);
DROP FUNCTION IF EXISTS cauce_dlq_post_030(text,text,text);
DROP FUNCTION IF EXISTS cauce_dlq_apply_030(text,text,text);
DROP FUNCTION IF EXISTS cauce_dlq_plan_030(text,text);
DROP FUNCTION IF EXISTS cauce_dlq_inspect_030(text,text);
DROP FUNCTION IF EXISTS cauce_dlq_plan_material_030(text,text);
DROP FUNCTION IF EXISTS cauce_dlq_snapshot_030(text,text);
DROP FUNCTION IF EXISTS cauce_dlq_candidates_030();
DROP FUNCTION IF EXISTS cauce_dlq_lock_control_tenant_030(text,text,text);
DROP FUNCTION IF EXISTS cauce_dlq_can_control_tenant_030(text,text);
DROP FUNCTION IF EXISTS cauce_dlq_assert_control_030(text,text);
DROP VIEW IF EXISTS cauce_dlq_inventory_030;

DROP TABLE IF EXISTS telegram_manual_replays;
DROP TABLE IF EXISTS dlq_operator_resolutions;
DROP TABLE IF EXISTS dlq_reconciliation_runs;
DROP TABLE IF EXISTS dlq_reconciliation_transitions;

DROP INDEX IF EXISTS outbox_dead_letters_open_disposition_idx;
DROP INDEX IF EXISTS dead_letters_open_disposition_idx;
DROP INDEX IF EXISTS audit_events_delivery_causal_030_idx;

ALTER TABLE telegram_egress_effects
  DROP CONSTRAINT IF EXISTS telegram_egress_effects_replay_generation_check;

ALTER TABLE outbox_dead_letters
  DROP CONSTRAINT IF EXISTS outbox_dead_letters_reopen_count_check,
  DROP CONSTRAINT IF EXISTS outbox_dead_letters_evidence_sha256_check,
  DROP CONSTRAINT IF EXISTS outbox_dead_letters_disposition_check,
  DROP COLUMN IF EXISTS last_reopened_at,
  DROP COLUMN IF EXISTS reopen_count,
  DROP COLUMN IF EXISTS evidence_sha256,
  DROP COLUMN IF EXISTS resolution_rule,
  DROP COLUMN IF EXISTS disposition_at,
  DROP COLUMN IF EXISTS disposition;

ALTER TABLE dead_letters
  DROP CONSTRAINT IF EXISTS dead_letters_evidence_sha256_check,
  DROP CONSTRAINT IF EXISTS dead_letters_disposition_check,
  DROP COLUMN IF EXISTS evidence_sha256,
  DROP COLUMN IF EXISTS resolution_rule,
  DROP COLUMN IF EXISTS disposition_at,
  DROP COLUMN IF EXISTS disposition;

DELETE FROM schema_migrations WHERE version='030_dlq_causal_reconciliation.sql';
