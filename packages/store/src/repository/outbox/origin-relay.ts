import type { DeliveryState, Origin } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { JobsRepository } from '../jobs.js';
import {
  originRelayTenant, type DeliveryRow, type LateRelayDisposition
} from '../observability.js';
import { objectRecord, textualReply, visibleText } from './contracts.js';

function hasRelayTransport(origin: Origin | null): origin is Origin {
  return origin !== null && origin.adapter !== 'console';
}

// Human-facing correction stays in Spanish; machine-to-machine notices stay in English.
const LATE_RESULT_HUMAN_NOTICE =
  '[respuesta tardía] Esta tarea se había dado por caída y ya te avisamos del fallo. '
  + 'El agente sí la terminó: su ACK final llegó después del plazo y el bus lo aceptó. '
  + 'El aviso de fallo anterior queda sin efecto. Respuesta:';

function relaySafeResult(
  result: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const output = objectRecord(result?.output);
  if (!result || !output || typeof output.reply !== 'string' || visibleText(output.reply)) return result;
  return { ...result, output: { ...output, reply: null } };
}

/** Prepend in relay-copy output.reply, the first visible field Telegram consumes;
 * deliveries.result retains the agent's original reply.
 */
function withReplyNotice(
  result: Record<string, unknown> | undefined,
  notice: string
): Record<string, unknown> | undefined {
  const output = objectRecord(result?.output);
  const reply = visibleText(output?.reply);
  if (!result || !output || !reply) return result;
  return { ...result, output: { ...output, reply: `${notice}\n\n${reply}` } };
}

export abstract class OriginRelayRepository extends JobsRepository {
  protected override async insertOriginRelay(
    client: DatabaseClient,
    row: DeliveryRow,
    outcome: string,
    ack: {
      result?: Record<string, unknown> | undefined;
      error?: string | undefined;
      error_code?: string | undefined;
    },
    late?: { previousStatus: DeliveryState; attempt: number }
  ): Promise<LateRelayDisposition> {
    if (!hasRelayTransport(row.origin)) return 'skipped';
    const rootMessageId = row.body.type === 'agent.fanin'
      ? this.rootMessageId(row)
      : undefined;
    const missingFinalReply = outcome === 'done' && !textualReply(ack.result);
    const relayOutcome = missingFinalReply ? 'failed' : outcome;
    const relayResult = relaySafeResult(ack.result);
    const visibleError = visibleText(ack.error);
    const visibleErrorCode = visibleText(ack.error_code);
    const relayError = missingFinalReply
      ? 'Successful origin relay requires a non-empty final reply'
      : visibleError || visibleErrorCode
        || (relayOutcome === 'done' ? undefined : `Delivery ended with outcome ${relayOutcome}`);
    const relayErrorCode = missingFinalReply ? 'MISSING_FINAL_REPLY' : visibleErrorCode || undefined;
    const relayTenant = originRelayTenant(row);
    const idempotencyKey = rootMessageId ? `relay-root:${rootMessageId}` : `relay:${row.id}`;
    const correlation = {
      request_id: row.request_id,
      message_id: row.message_id,
      delivery_id: row.id,
      trace_id: row.trace_id,
      ...(rootMessageId ? { root_message_id: rootMessageId } : {})
    };
    const payload = (result: Record<string, unknown> | undefined): string => JSON.stringify({
      outcome: relayOutcome,
      ...(result === undefined ? {} : { result }),
      ...(relayError === undefined ? {} : { error: relayError }),
      ...(relayErrorCode === undefined ? {} : { error_code: relayErrorCode }),
      ...(late === undefined ? {} : {
        late_result: true,
        superseded_outcome: late.previousStatus,
        late_result_attempt: late.attempt
      }),
      correlation
    });
    if (late === undefined) {
      await client.query(
        `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
         VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
         ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
        [relayTenant, row.origin.adapter, idempotencyKey,
          row.request_id, row.message_id, row.id,
          row.trace_id, JSON.stringify(row.origin), payload(relayResult)]
      );
      return 'inserted';
    }
    // The death notice already written by the reaper (or the prior terminal ACK) is taken under
    // lock: either we reach it before the dispatcher claims it, or we wait for it to be claimed and
    // then we know for sure the person will see it.
    const prior = await client.query<{ id: string; status: string }>(
      `SELECT id,status FROM adapter_outbox
       WHERE tenant_id=$1 AND adapter=$2 AND idempotency_key=$3 FOR UPDATE`,
      [relayTenant, row.origin.adapter, idempotencyKey]
    );
    const priorStatus = prior.rows[0]?.status;
    if (priorStatus === 'pending' || priorStatus === 'failed') {
      // Nobody has sent it yet: it is rewritten in place and the person gets ONE message, the right
      // one. Without a correction header, because there is nothing to correct for them.
      await client.query(
        `UPDATE adapter_outbox
         SET payload=$2::jsonb,status='pending',available_at=now(),attempts=0,last_error=NULL,
             claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,claimed_at=NULL,dead_at=NULL
         WHERE id=$1`,
        [prior.rows[0]!.id, payload(relayResult)]
      );
      return 'rewritten';
    }
    if (priorStatus === undefined) {
      await client.query(
        `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
         VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
         ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
        [relayTenant, row.origin.adapter, idempotencyKey,
          row.request_id, row.message_id, row.id,
          row.trace_id, JSON.stringify(row.origin), payload(relayResult)]
      );
      return 'inserted';
    }
    // Already sent or being sent. A new message goes, with the response preceded by the notice.
    await client.query(
      `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
       VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
       ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
      [relayTenant, row.origin.adapter, `relay-late:${row.id}:${late.attempt}`,
        row.request_id, row.message_id, row.id,
        row.trace_id, JSON.stringify(row.origin),
        payload(withReplyNotice(relayResult, LATE_RESULT_HUMAN_NOTICE))]
    );
    return 'corrected';
  }

}
