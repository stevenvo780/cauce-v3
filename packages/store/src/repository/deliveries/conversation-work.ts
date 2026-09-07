import { redactSecrets, type ConversationWorkState, type Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import type { DeliveryRow } from '../observability.js';

export function workExcerpt(value: string | null, limit: number): string {
  if (value === null) return '';
  if (/(?:^|[^a-z0-9_])["']?(?:password|passwd|contraseña|cookie|set-cookie)["']?\s*[:=\r\n]/iu.test(value)) {
    return '[Contenido omitido: contiene credenciales]';
  }
  const redacted = redactSecrets(value, { enabled: true });
  if (redacted.unscanned !== undefined) return '[Resumen omitido: supera el limite de saneamiento]';
  const safe = redacted.value.replace(/\bxai-[A-Za-z0-9_-]{20,}/gu, '[secreto-redactado]');
  if (safe.length <= limit) return safe;
  const half = Math.floor((limit - 5) / 2);
  const head = safe.slice(0, half).replace(/[\uD800-\uDBFF]$/u, '');
  const tail = safe.slice(-half).replace(/^[\uDC00-\uDFFF]/u, '');
  return `${head} […] ${tail}`;
}

interface WorkRow {
  source_delivery_id: string;
  child_delivery_id: string;
  root_message_id: string;
  target_alias: string;
  status: ConversationWorkState['branches'][number]['status'];
  updated_at: Date;
  task: string | null;
  result: string | null;
  review: string | null;
  review_status: ConversationWorkState['branches'][number]['review_status'];
  review_updated_at: Date | null;
  review_input_at: Date | null;
  as_of: Date;
  has_more: boolean;
}

export function conversationWorkScopeKey(delivery: DeliveryRow): string | undefined {
  const origin = delivery.origin;
  if (!origin || !delivery.auth_session_id || !delivery.auth_channel
      || /^(?:delivery|fanin):/u.test(delivery.auth_session_id)
      || delivery.body.type === 'agent.message' || delivery.body.type === 'agent.fanin') return undefined;
  return JSON.stringify([delivery.auth_session_id, delivery.auth_channel,
    origin.adapter, origin.channel, origin.conversation_id]);
}

export async function conversationWorkState(
  client: DatabaseClient,
  tenant: Tenant,
  alias: string,
  delivery: DeliveryRow,
): Promise<ConversationWorkState | undefined> {
  const origin = delivery.origin;
  if (!origin || conversationWorkScopeKey(delivery) === undefined) return undefined;
  const result = await client.query<WorkRow>(
    `WITH selected AS MATERIALIZED (
       SELECT materialization.source_delivery_id,child.id AS child_delivery_id,
            COALESCE(materialization.correlation->>'root_message_id', source.id::text) AS root_message_id,
            materialization.target_alias,child.status,child.updated_at,
            task.body->>'text' AS task,
            COALESCE(child.result->'output'->>'reply',child.last_error) AS result,
            source.trace_id,materialization.created_at,materialization.output_index,
            child.status IN ('pending','leased','accepted','started','retry') AS active
       FROM agent_output_materializations materialization
       JOIN messages source ON source.id=materialization.source_message_id
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       JOIN messages task ON task.id=child.message_id
      WHERE materialization.source_tenant=$1 AND materialization.source_alias=$2
        AND materialization.target_tenant=$1 AND materialization.status='materialized'
        AND source.auth_session_id=$3 AND source.auth_channel=$4
        AND source.origin->>'adapter'=$5 AND source.origin->>'channel'=$6
        AND source.origin->>'conversation_id'=$7
      ORDER BY active DESC,materialization.created_at DESC,materialization.source_delivery_id,
               materialization.output_index LIMIT 17
     ), visible AS MATERIALIZED (
       SELECT * FROM selected ORDER BY active DESC,created_at DESC,source_delivery_id,output_index LIMIT 16
     )
     SELECT visible.*,review.result->'output'->>'reply' AS review,review.status AS review_status,
            review.updated_at AS review_updated_at,
            review.input_at AS review_input_at,
            statement_timestamp() AS as_of,(SELECT count(*)>16 FROM selected) AS has_more
       FROM visible
       LEFT JOIN LATERAL (
         SELECT response_delivery.result,response_delivery.status,response_delivery.updated_at,
                response.created_at AS input_at
           FROM messages response
           JOIN deliveries response_delivery ON response_delivery.message_id=response.id
          WHERE response.body->>'type'='agent.response'
            AND response.trace_id=visible.trace_id
            AND response.body->'correlation'->>'root_message_id'=visible.root_message_id
            AND response.body->'correlation'->>'child_delivery_id'=visible.child_delivery_id::text
            AND response_delivery.recipient_tenant=$1 AND response_delivery.recipient_alias=$2
            AND response.body->'correlation'->>'response_to_delivery_id'=visible.source_delivery_id::text
          ORDER BY response.created_at DESC,response_delivery.updated_at DESC,response_delivery.id DESC LIMIT 1
       ) review ON true
      ORDER BY visible.active DESC,visible.created_at DESC,visible.source_delivery_id,visible.output_index`,
    [tenant, alias, delivery.auth_session_id, delivery.auth_channel,
      origin.adapter, origin.channel, origin.conversation_id],
  );
  const first = result.rows[0];
  if (!first) return undefined;
  const unit = Math.min(2048, Math.floor(32768 / (result.rows.length * 4)));
  return {
    as_of: first.as_of.toISOString(),
    has_more: first.has_more,
    branches: result.rows.map((row) => ({
      source_delivery_id: row.source_delivery_id,
      child_delivery_id: row.child_delivery_id,
      root_message_id: row.root_message_id,
      target_alias: row.target_alias,
      status: row.status,
      updated_at: row.updated_at.toISOString(),
      task_untrusted: workExcerpt(row.task, unit),
      result_untrusted: workExcerpt(row.result, unit * 2),
      review_untrusted: workExcerpt(row.review, unit),
      review_status: row.review_status,
      review_updated_at: row.review_updated_at?.toISOString() ?? null,
      review_input_at: row.review_input_at?.toISOString() ?? null,
      review_matches_current_result: row.review_input_at !== null
        && (row.review_status === 'done' || row.review_status === 'failed')
        && row.review_input_at >= row.updated_at,
    })),
  };
}
