// The same branch selection supplies text, media metadata and the authorized binary download.
export const CANONICAL_REPLY_JOIN_SQL = `LEFT JOIN LATERAL (
  SELECT candidate.id,candidate.attempt,candidate.status,candidate.result
  FROM (
    SELECT c.id,COALESCE(c.late_result_attempt,c.attempt) AS attempt,c.status,
      CASE WHEN c.status='done' THEN c.result END AS result,
      0 AS priority,c.terminal_at,c.created_at
    FROM messages cm JOIN deliveries c ON c.message_id=cm.id
    WHERE cm.body->'correlation'->>'root_message_id'=d.message_id::text
      AND cm.body->>'type'='agent.fanin'
      AND cm.body->'correlation'->>'root_delivery_id'=d.id::text
      AND c.recipient_tenant=d.recipient_tenant AND c.recipient_alias=d.recipient_alias
    UNION ALL
    SELECT c.id,COALESCE(c.late_result_attempt,c.attempt),c.status,c.result,
      1,c.terminal_at,c.created_at
    FROM messages cm JOIN deliveries c ON c.message_id=cm.id
    WHERE cm.body->'correlation'->>'root_message_id'=d.message_id::text
      AND cm.body->>'type'='agent.response'
      AND cm.body->'correlation'->>'root_delivery_id'=d.id::text
      AND c.recipient_tenant=d.recipient_tenant AND c.recipient_alias=d.recipient_alias
      AND c.status='done' AND (c.result->'output'->>'reply' IS NOT NULL
        OR CASE WHEN jsonb_typeof(c.result->'reply_attachments_v1')='array'
          THEN jsonb_array_length(c.result->'reply_attachments_v1')>0 ELSE false END)
    UNION ALL
    SELECT d.id,COALESCE(d.late_result_attempt,d.attempt),d.status,d.result,
      2,d.terminal_at,d.created_at
  ) candidate
  ORDER BY priority,
    CASE WHEN priority=1 THEN terminal_at END DESC NULLS LAST,
    created_at DESC,id DESC LIMIT 1
) effective ON true`;
