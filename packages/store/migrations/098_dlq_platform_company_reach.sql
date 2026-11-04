SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_098);

-- A platform administrator acting in a company already replays and cancels that company's
-- deliveries (gateway store reach, 2026-11-04). The DLQ inventory and its no-replay decision lived
-- only behind the tenant ACL edges of 030, so a dead letter of a company with no hub edge to the
-- operator's tenant (praxis/Hospital seen from humanizar/Steven) could be neither listed nor closed.
-- These functions add exactly that reach. They never widen the 030 functions, which keep serving
-- every other caller unchanged.
--
-- The store resolves and verifies the person's authority (platform_admin, scope platform, same
-- tenant and alias) before calling them; the functions re-check what the database can prove: the
-- actor still holds control in its home tenant, the person is still a platform administrator and
-- the letter's tenant belongs to the acting company.

-- The tenant is in the company the platform administrator is acting in.
CREATE FUNCTION cauce_dlq_platform_reach_098(p_acting_company text, p_target_tenant text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
SELECT p_acting_company IS NOT NULL AND EXISTS (
  SELECT 1 FROM tenants tenant
  WHERE tenant.id=p_target_tenant AND tenant.enabled AND tenant.company_id=p_acting_company
)
$$;

-- What the 030 classifier (cauce_dlq_candidates_030, delivery_classification) would assign to an
-- unresolved delivery/job letter still unclassified, with the same evidence formula, so the operator
-- decision binds to exactly the state the reconciler would have recorded.
CREATE FUNCTION cauce_dlq_platform_classification_098(p_dead_letter_id uuid)
RETURNS TABLE(disposition text, evidence_sha256 text)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
SELECT desired.disposition,
       encode(digest(convert_to(concat_ws('|',
         'classify',letter.id::text,COALESCE(delivery.id::text,''),
         COALESCE(delivery.status,''),COALESCE(delivery.attempt::text,''),
         COALESCE((delivery.execution_started_at IS NOT NULL)::text,''),
         desired.disposition
       ),'UTF8'),'sha256'),'hex')
FROM dead_letters letter
LEFT JOIN deliveries delivery ON delivery.id=letter.delivery_id
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN delivery.id IS NULL THEN 'missing_final'
    WHEN delivery.execution_started_at IS NOT NULL THEN 'ambiguous'
    WHEN delivery.status IN ('dead','failed') THEN 'safe_retry'
    ELSE 'unclassified'
  END::text AS disposition
) desired
WHERE letter.id=p_dead_letter_id AND letter.resolved_at IS NULL
  AND letter.disposition='unclassified' AND letter.disposition_at IS NULL
$$;

-- The person behind the session is still a platform administrator and the actor still controls
-- its home tenant; anything else fails closed before a row is read.
CREATE FUNCTION cauce_dlq_assert_platform_098(
  p_actor_tenant text, p_actor_alias text, p_acting_company text, p_actor_human_id uuid
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM cauce_dlq_assert_control_030(p_actor_tenant,p_actor_alias);
  IF p_acting_company IS NULL OR p_acting_company !~ '^[a-z][a-z0-9_-]{0,63}$' OR p_actor_human_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM platform_admins admin WHERE admin.human_id=p_actor_human_id)
     OR NOT EXISTS (SELECT 1 FROM companies company WHERE company.id=p_acting_company AND company.enabled) THEN
    RAISE EXCEPTION 'DLQ platform reach requires a current platform administrator acting in an enabled company';
  END IF;
END
$$;

-- Same contract as cauce_list_dlq_030 plus the acting company's letters. Letters reached only
-- through the company and still unclassified carry the 030 classification and its evidence; they
-- are actionable only when that classification is ambiguous or missing_final, the cases where a
-- replay could duplicate an effect. A never-started letter (safe_retry) is meant to be replayed.
CREATE FUNCTION cauce_list_dlq_platform_098(
  p_actor_tenant text, p_actor_alias text, p_acting_company text, p_actor_human_id uuid,
  p_limit integer, p_cursor text
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  items jsonb;
  total bigint;
  has_more boolean;
  next_cursor text;
  cursor_payload jsonb;
  cursor_created_at timestamptz;
  cursor_target text;
  cursor_id uuid;
  cursor_scope_sha256 text;
  expected_scope_sha256 text;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN
    RAISE EXCEPTION 'DLQ list limit must be between 1 and 500';
  END IF;
  PERFORM cauce_dlq_assert_platform_098(p_actor_tenant,p_actor_alias,p_acting_company,p_actor_human_id);
  -- A different scope than 030's: a cursor never crosses between the two lists.
  expected_scope_sha256 := encode(digest(convert_to(
    p_actor_tenant || chr(31) || p_actor_alias || chr(31) || 'platform' || chr(31) || p_acting_company,'UTF8'
  ),'sha256'),'hex');
  IF p_cursor IS NOT NULL THEN
    IF length(p_cursor)>1024 OR length(p_cursor)<2 OR length(p_cursor)%2<>0
       OR p_cursor !~ '^[a-f0-9]+$' THEN
      RAISE EXCEPTION 'DLQ list cursor is invalid' USING ERRCODE='22023';
    END IF;
    BEGIN
      cursor_payload := convert_from(decode(p_cursor,'hex'),'UTF8')::jsonb;
      IF jsonb_typeof(cursor_payload)<>'object' THEN
        RAISE EXCEPTION 'invalid cursor shape';
      END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(cursor_payload))<>5
         OR NOT cursor_payload ?& ARRAY['v','createdAt','target','id','scopeSha256'] THEN
        RAISE EXCEPTION 'invalid cursor fields';
      END IF;
      cursor_created_at := (cursor_payload->>'createdAt')::timestamptz;
      cursor_target := cursor_payload->>'target';
      cursor_id := (cursor_payload->>'id')::uuid;
      cursor_scope_sha256 := cursor_payload->>'scopeSha256';
      IF cursor_payload->>'v'<>'1' OR NOT isfinite(cursor_created_at)
         OR cursor_target NOT IN ('outbox','delivery')
         OR cursor_payload->>'createdAt'<>to_char(
           cursor_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         )
         OR cursor_payload->>'id'<>cursor_id::text
         OR cursor_scope_sha256 IS DISTINCT FROM expected_scope_sha256 THEN
        RAISE EXCEPTION 'invalid cursor values';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'DLQ list cursor is invalid' USING ERRCODE='22023';
    END;
  END IF;
  WITH scoped AS (
    SELECT 'outbox'::text AS target,letter.id,letter.tenant_id,
           letter.kind::text AS kind,letter.adapter::text AS adapter,
           letter.disposition,letter.evidence_sha256,letter.attempts,letter.resolution_rule,
           letter.created_at,letter.disposition_at,letter.resolved_at,
           letter.reopen_count,letter.last_reopened_at,
           cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id) AS controlled
    FROM outbox_dead_letters letter
    UNION ALL
    SELECT 'delivery'::text,letter.id,letter.tenant_id,
           CASE WHEN letter.delivery_id IS NOT NULL THEN 'delivery' ELSE 'job' END::text,
           NULL::text,letter.disposition,letter.evidence_sha256,letter.attempts,letter.resolution_rule,
           letter.created_at,letter.disposition_at,letter.resolved_at,
           0,NULL::timestamptz,
           cauce_dlq_lock_control_tenant_030(p_actor_tenant,p_actor_alias,letter.tenant_id)
    FROM dead_letters letter
  ), visible AS (
    SELECT scoped.target,scoped.id,scoped.tenant_id,scoped.kind,scoped.adapter,
           COALESCE(proposed.disposition,scoped.disposition) AS disposition,
           scoped.resolved_at IS NULL AS open,
           scoped.resolved_at IS NULL AND (
             scoped.disposition IN ('ambiguous','safe_retry','missing_final','auth')
             OR COALESCE(proposed.disposition IN ('ambiguous','missing_final'),false)
           ) AS actionable,
           COALESCE(proposed.evidence_sha256,scoped.evidence_sha256) AS evidence_sha256,
           scoped.attempts,scoped.resolution_rule,scoped.created_at,scoped.disposition_at,
           scoped.resolved_at,scoped.reopen_count,scoped.last_reopened_at
    FROM scoped
    LEFT JOIN LATERAL (
      SELECT classification.disposition,classification.evidence_sha256
      FROM cauce_dlq_platform_classification_098(scoped.id) classification
      WHERE scoped.target='delivery' AND NOT scoped.controlled
        AND classification.disposition IN ('ambiguous','missing_final')
    ) proposed ON true
    WHERE scoped.controlled OR cauce_dlq_platform_reach_098(p_acting_company,scoped.tenant_id)
  ), counted AS (
    SELECT count(*) AS count FROM visible
  ), filtered AS (
    SELECT * FROM visible
    WHERE cursor_created_at IS NULL
       OR (created_at,target,id)<(cursor_created_at,cursor_target,cursor_id)
  ), page AS (
    SELECT * FROM filtered
    ORDER BY created_at DESC,target DESC,id DESC
    LIMIT p_limit+1
  ), selected AS (
    SELECT * FROM page
    ORDER BY created_at DESC,target DESC,id DESC
    LIMIT p_limit
  ), page_meta AS (
    SELECT count(*)>p_limit AS has_more FROM page
  ), last_selected AS (
    SELECT * FROM selected
    ORDER BY created_at ASC,target ASC,id ASC
    LIMIT 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'target',selected.target,'id',selected.id,'tenantId',selected.tenant_id,
           'kind',selected.kind,
           'adapter',selected.adapter,'disposition',selected.disposition,
           'open',selected.open,'actionable',selected.actionable,
           'evidenceSha256',selected.evidence_sha256,
           'attempts',selected.attempts,'resolutionRule',selected.resolution_rule,
           'createdAt',selected.created_at,'dispositionAt',selected.disposition_at,
           'resolvedAt',selected.resolved_at,'reopenCount',selected.reopen_count,
           'lastReopenedAt',selected.last_reopened_at
         ) ORDER BY selected.created_at DESC,selected.target DESC,selected.id DESC)
         FILTER (WHERE selected.id IS NOT NULL),'[]'::jsonb),
         counted.count,page_meta.has_more,
         CASE WHEN page_meta.has_more THEN encode(convert_to(jsonb_build_object(
           'v',1,
           'createdAt',to_char(
             last_selected.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ),
           'target',last_selected.target,
           'id',last_selected.id,
           'scopeSha256',expected_scope_sha256
         )::text,'UTF8'),'hex') ELSE NULL END
  INTO items,total,has_more,next_cursor
  FROM counted CROSS JOIN page_meta
  LEFT JOIN selected ON true
  LEFT JOIN last_selected ON true
  GROUP BY counted.count,page_meta.has_more,last_selected.created_at,
           last_selected.target,last_selected.id;
  RETURN jsonb_build_object(
    'schemaVersion',1,'items',items,'total',COALESCE(total,0),
    'truncated',COALESCE(has_more,false),'nextCursor',next_cursor
  );
END
$$;

-- The 030 no-replay decision for a letter of the acting company. A letter still unclassified is
-- first classified exactly as the 030 reconciler would (recorded as its own dlq.reconcile
-- transition) and only then closed; that path requires both risk acknowledgements and only exists
-- for ambiguous/missing_final classifications. The audit keeps the real actor and names the
-- person, the acting company and the override.
CREATE FUNCTION cauce_resolve_dlq_without_replay_platform_098(
  p_target text, p_dead_letter_id uuid, p_evidence_sha256 text, p_reason text,
  p_actor_tenant text, p_actor_alias text, p_acting_company text, p_actor_human_id uuid, p_home_company text,
  p_possible_duplicate_acknowledged boolean, p_possible_no_delivery_acknowledged boolean
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  target_tenant text;
  current_disposition text;
  current_disposition_at timestamptz;
  current_evidence text;
  current_resolved_at timestamptz;
  classified_disposition text;
  classified_evidence text;
  final_disposition text;
  actor_sha256 text;
  reason_sha256 text;
  classify_audit_id bigint;
  audit_id bigint;
  changed integer;
  existing dlq_operator_resolutions%ROWTYPE;
BEGIN
  IF p_target NOT IN ('delivery','outbox') OR p_dead_letter_id IS NULL
     OR p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'DLQ no-replay resolution requires an exact target, id and evidence SHA-256';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000
     OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'DLQ no-replay resolution requires a bounded non-empty reason';
  END IF;
  IF NOT COALESCE(p_possible_no_delivery_acknowledged,false) THEN
    RAISE EXCEPTION 'DLQ no-replay resolution requires no-delivery acknowledgement';
  END IF;
  PERFORM cauce_dlq_assert_platform_098(p_actor_tenant,p_actor_alias,p_acting_company,p_actor_human_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('cauce-dlq-reconciliation:v1',0));
  actor_sha256 := encode(digest(convert_to(p_actor_tenant || chr(31) || p_actor_alias,'UTF8'),'sha256'),'hex');

  SELECT * INTO existing FROM dlq_operator_resolutions
  WHERE target=p_target AND dead_letter_id=p_dead_letter_id
    AND evidence_sha256=p_evidence_sha256 FOR UPDATE;
  IF FOUND THEN
    IF existing.actor_tenant<>p_actor_tenant OR existing.actor_alias<>p_actor_alias THEN
      RAISE EXCEPTION 'DLQ incident was already resolved by a different actor';
    END IF;
    IF existing.reason<>btrim(p_reason)
       OR existing.possible_duplicate_acknowledged<>COALESCE(p_possible_duplicate_acknowledged,false)
       OR existing.possible_no_delivery_acknowledged<>COALESCE(p_possible_no_delivery_acknowledged,false) THEN
      RAISE EXCEPTION 'DLQ incident was already resolved with a different operator decision';
    END IF;
    RETURN jsonb_build_object(
      'schemaVersion',1,'suite','cauce-v3-dlq-no-replay-resolution','phase','resolved',
      'appliedCount',0,'alreadyApplied',true,'evidenceSha256',p_evidence_sha256,
      'reasonSha256',encode(digest(convert_to(existing.reason,'UTF8'),'sha256'),'hex'),
      'possibleDuplicateAcknowledged',existing.possible_duplicate_acknowledged,
      'possibleNoDeliveryAcknowledged',existing.possible_no_delivery_acknowledged
    );
  END IF;

  IF p_target='outbox' THEN
    SELECT letter.tenant_id,letter.disposition,letter.disposition_at,letter.evidence_sha256,letter.resolved_at
    INTO target_tenant,current_disposition,current_disposition_at,current_evidence,current_resolved_at
    FROM outbox_dead_letters letter WHERE letter.id=p_dead_letter_id FOR UPDATE;
  ELSE
    SELECT letter.tenant_id,letter.disposition,letter.disposition_at,letter.evidence_sha256,letter.resolved_at
    INTO target_tenant,current_disposition,current_disposition_at,current_evidence,current_resolved_at
    FROM dead_letters letter WHERE letter.id=p_dead_letter_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DLQ no-replay resolution was fenced by current incident state or evidence';
  END IF;
  PERFORM 1 FROM tenants scoped_tenant WHERE scoped_tenant.id=target_tenant FOR SHARE OF scoped_tenant;
  IF NOT cauce_dlq_platform_reach_098(p_acting_company,target_tenant) THEN
    RAISE EXCEPTION 'DLQ no-replay target is outside the acting company';
  END IF;
  IF current_resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'DLQ no-replay resolution was fenced by current incident state or evidence';
  END IF;

  IF current_disposition IN ('ambiguous','safe_retry','missing_final','auth') THEN
    IF current_evidence IS DISTINCT FROM p_evidence_sha256 THEN
      RAISE EXCEPTION 'DLQ no-replay resolution was fenced by current incident state or evidence';
    END IF;
    final_disposition := current_disposition;
  ELSIF p_target='delivery' AND current_disposition='unclassified' AND current_disposition_at IS NULL THEN
    SELECT classification.disposition,classification.evidence_sha256
    INTO classified_disposition,classified_evidence
    FROM cauce_dlq_platform_classification_098(p_dead_letter_id) classification;
    IF classified_disposition IS NULL OR classified_disposition NOT IN ('ambiguous','missing_final')
       OR classified_evidence IS DISTINCT FROM p_evidence_sha256 THEN
      RAISE EXCEPTION 'DLQ no-replay resolution was fenced by current incident state or evidence';
    END IF;
    IF NOT COALESCE(p_possible_duplicate_acknowledged,false) THEN
      RAISE EXCEPTION 'DLQ no-replay resolution of an unclassified incident requires both risk acknowledgements';
    END IF;
    UPDATE dead_letters SET
      disposition=classified_disposition,disposition_at=now(),evidence_sha256=classified_evidence
    WHERE id=p_dead_letter_id AND resolved_at IS NULL
      AND disposition='unclassified' AND disposition_at IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'DLQ no-replay resolution CAS was fenced'; END IF;
    INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata,company_id,actor_human_id)
    VALUES(
      target_tenant,p_actor_alias,'dlq.reconcile','info',
      jsonb_build_object(
        'schema_version',1,'rule','classify_' || classified_disposition || '_v1',
        'actor_sha256',actor_sha256,
        'counts',jsonb_build_object('transitions',1,'resolved',0,'recovered_sent',0,'dispositions',1),
        'evidence_sha256',classified_evidence,
        'acting_company',p_acting_company,'home_company',p_home_company,'platform_override',true
      ),
      p_acting_company,p_actor_human_id
    ) RETURNING id INTO classify_audit_id;
    INSERT INTO dlq_reconciliation_transitions(
      target,dead_letter_id,rule,actor_tenant,actor_alias,evidence_sha256,
      from_disposition,to_disposition,resolved,audit_event_id
    ) VALUES(
      p_target,p_dead_letter_id,'classify_' || classified_disposition || '_v1',p_actor_tenant,p_actor_alias,
      classified_evidence,'unclassified',classified_disposition,false,classify_audit_id
    );
    final_disposition := classified_disposition;
  ELSE
    RAISE EXCEPTION 'DLQ no-replay resolution was fenced by current incident state or evidence';
  END IF;
  IF final_disposition IN ('ambiguous','missing_final')
     AND NOT COALESCE(p_possible_duplicate_acknowledged,false) THEN
    RAISE EXCEPTION 'DLQ no-replay resolution requires possible-duplicate acknowledgement for uncertain effects';
  END IF;

  reason_sha256 := encode(digest(convert_to(btrim(p_reason),'UTF8'),'sha256'),'hex');
  IF p_target='outbox' THEN
    UPDATE outbox_dead_letters SET
      resolved_at=now(),resolution_rule='operator_no_replay_v1',disposition_at=now()
    WHERE id=p_dead_letter_id AND resolved_at IS NULL
      AND disposition=final_disposition
      AND evidence_sha256=p_evidence_sha256;
  ELSE
    UPDATE dead_letters SET
      resolved_at=now(),resolution_rule='operator_no_replay_v1',disposition_at=now()
    WHERE id=p_dead_letter_id AND resolved_at IS NULL
      AND disposition=final_disposition
      AND evidence_sha256=p_evidence_sha256;
  END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'DLQ no-replay resolution CAS was fenced'; END IF;

  INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata,company_id,actor_human_id)
  VALUES(
    target_tenant,p_actor_alias,'dlq.resolve_without_replay','allow',
    jsonb_build_object(
      'schema_version',1,'rule','operator_no_replay_v1','actor_sha256',actor_sha256,
      'actor_tenant',p_actor_tenant,
      'counts',jsonb_build_object('transitions',1,'resolved',1,'replayed',0),
      'evidence_sha256',p_evidence_sha256,'reason_sha256',reason_sha256,
      'possible_duplicate_acknowledged',COALESCE(p_possible_duplicate_acknowledged,false),
      'possible_no_delivery_acknowledged',true,
      'classified_from_unclassified',classified_disposition IS NOT NULL,
      'acting_company',p_acting_company,'home_company',p_home_company,'platform_override',true
    ),
    p_acting_company,p_actor_human_id
  ) RETURNING id INTO audit_id;
  INSERT INTO dlq_operator_resolutions(
    target,dead_letter_id,evidence_sha256,actor_tenant,actor_alias,reason,
    possible_duplicate_acknowledged,possible_no_delivery_acknowledged,audit_event_id
  ) VALUES(
    p_target,p_dead_letter_id,p_evidence_sha256,p_actor_tenant,p_actor_alias,btrim(p_reason),
    COALESCE(p_possible_duplicate_acknowledged,false),true,audit_id
  );
  INSERT INTO dlq_reconciliation_transitions(
    target,dead_letter_id,rule,actor_tenant,actor_alias,evidence_sha256,
    from_disposition,to_disposition,resolved,audit_event_id
  ) VALUES(
    p_target,p_dead_letter_id,'operator_no_replay_v1',p_actor_tenant,p_actor_alias,
    p_evidence_sha256,final_disposition,final_disposition,true,audit_id
  );
  RETURN jsonb_build_object(
    'schemaVersion',1,'suite','cauce-v3-dlq-no-replay-resolution','phase','resolved',
    'appliedCount',1,'alreadyApplied',false,'evidenceSha256',p_evidence_sha256,
    'reasonSha256',reason_sha256,
    'possibleDuplicateAcknowledged',COALESCE(p_possible_duplicate_acknowledged,false),
    'possibleNoDeliveryAcknowledged',true
  );
END
$$;
