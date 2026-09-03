import type { DatabaseClient } from '../../../db.js';
import {
  originRelayTenant, truncateUtf8, type ChainPolicy, type DeliveryRow
} from '../../observability.js';
import { visibleText } from '../../outbox.js';
import {
  isDelegatedSubAgentTurn, maxProgressSummaryBytes, progressRelayCappedText,
  type AgentChainProgressStage
} from './helpers.js';

export async function insertProgressRelay(
  client: DatabaseClient,
  row: DeliveryRow,
  attempt: number,
  policy: ChainPolicy,
  rootMessageId: string | undefined,
  stage: Exclude<AgentChainProgressStage, 'capped'>,
  summary: string
): Promise<void> {
  if (!policy.progressRelayEnabled || policy.progressRelayMaxEvents < 1) return;
  if (row.origin?.adapter !== 'telegram') return;
  if (rootMessageId === undefined || !visibleText(summary)) return;
  if (stage !== 'denied' && isDelegatedSubAgentTurn(row)) return;
  await client.query(
    `INSERT INTO agent_chain_progress(root_message_id) VALUES($1)
     ON CONFLICT(root_message_id) DO NOTHING`,
    [rootMessageId]
  );
  const reserved = await client.query<{ emitted: number }>(
    `SELECT emitted FROM agent_chain_progress WHERE root_message_id=$1 FOR UPDATE`,
    [rootMessageId]
  );
  const emitted = reserved.rows[0]?.emitted;
  if (emitted === undefined || emitted >= policy.progressRelayMaxEvents) return;
  // The last available slot is the cap notice itself, never one additional relay.
  const capped = emitted === policy.progressRelayMaxEvents - 1;
  const relayStage: AgentChainProgressStage = capped ? 'capped' : stage;
  const idempotencyKey = capped
    ? `relay-progress-capped:${rootMessageId}`
    : `relay-progress:${row.id}:${String(attempt)}:${stage}`;
  const text = capped
    ? progressRelayCappedText
    : truncateUtf8(summary, maxProgressSummaryBytes).value;
  const inserted = await client.query(
    `INSERT INTO adapter_outbox(
       tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
     ) VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
     ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING
     RETURNING id`,
    [
      originRelayTenant(row), row.origin.adapter, idempotencyKey, row.request_id, row.message_id,
      row.id, row.trace_id, JSON.stringify(row.origin),
      JSON.stringify({
        relay_kind: 'ack',
        terminal: false,
        outcome: 'ack',
        progress_stage: relayStage,
        result: {
          output: {
            reply: text,
            messages: [],
            status: 'done',
            retryable: false,
            artifacts: []
          }
        },
        correlation: {
          request_id: row.request_id,
          message_id: row.message_id,
          trace_id: row.trace_id,
          root_message_id: rootMessageId
        }
      })
    ]
  );
  if (inserted.rowCount !== 1) return;
  await client.query(
    `UPDATE agent_chain_progress SET emitted=emitted+1 WHERE root_message_id=$1`,
    [rootMessageId]
  );
}
