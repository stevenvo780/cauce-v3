import { isRfcUuid, type Ack } from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import type { DatabaseClient } from '../../../db.js';
import { rejectionText, type RejectionNotice } from '../../../delegation-guard.js';
import type { OpenChainGate } from '../../deliveries.js';
import {
  originRelayTenant, truncateUtf8, type DeliveryRow
} from '../../observability.js';
import { objectRecord } from '../../outbox.js';
import {
  maxChainGateQuestionBytes, type AgentOutputLineage, type AgentOutputRejectionCode
} from './policy.js';

/**
 * Resolves the branch that opened this coordinator turn when the delivery being ACKed is
 * an authenticated agent.response continuation. The store proved that correlation with an
 * audit row when it created the response, so the delegation path keeps growing across
 * continuations instead of restarting at every hop.
 */
export async function continuationBranchMaterialization(
  client: DatabaseClient,
  row: DeliveryRow,
  visitedPathAvailable: boolean
): Promise<AgentOutputLineage | undefined> {
  if (row.body.type !== 'agent.response') return undefined;
  const correlation = objectRecord(row.body.correlation);
  const claimed = isRfcUuid(correlation?.response_to_delivery_id)
    ? correlation.response_to_delivery_id
    : undefined;
  if (claimed === undefined) return undefined;
  const trusted = await client.query(
    `SELECT 1 FROM audit_events
       WHERE message_id=$1 AND delivery_id=$2
         AND action='agent_output.response' AND decision='allow'
       LIMIT 1 FOR SHARE`,
    [row.message_id, row.id]
  );
  if (trusted.rowCount !== 1) return undefined;
  const parent = await client.query<AgentOutputLineage>(
    `SELECT materialization.hop_count,materialization.hop_budget,materialization.correlation,
              ${visitedPathAvailable ? 'materialization.visited_path' : `'{}'::text[] AS visited_path`}
       FROM agent_output_materializations materialization
       WHERE materialization.produced_delivery_id=$1 AND materialization.status='materialized'
       LIMIT 1
       FOR SHARE OF materialization`,
    [claimed]
  );
  return parent.rows[0];
}

/** The open gate of a root, if any. `FOR SHARE` is the interlock against `answerChainGate`. */
export async function openChainGateFor(
  client: DatabaseClient,
  rootMessageId: string | undefined
): Promise<OpenChainGate | undefined> {
  if (rootMessageId === undefined) return undefined;
  const gate = await client.query<{ id: string; question: string }>(
    `SELECT id,question FROM agent_chain_gates
       WHERE root_message_id=$1 AND status='open' LIMIT 1 FOR SHARE`,
    [rootMessageId]
  );
  return gate.rows[0];
}

/**
 * Turns a question to a human into a ROW, not a delivery.
 *
 * Returns `undefined` when another branch of the same root won the race and left an open
 * gate: the partial unique index `agent_chain_gates_open_root_idx` is what guarantees the
 * question goes out ONCE, and `ON CONFLICT DO NOTHING` makes it a no-op rather than a
 * violation aborting the ACK transaction.
 *
 * The question is relayed to the human channel via `adapter_outbox` reusing the non-terminal
 * ack shape the bridge already implements (same as insertProgressRelay), so there is no
 * deployment ordering between store and bridge.
 */
export async function openHumanGate(
  client: DatabaseClient,
  row: DeliveryRow,
  ack: Ack,
  outputIndex: number,
  input: { rootMessageId: string; question: string; correlation: Record<string, unknown> }
): Promise<OpenChainGate | undefined> {
  const question = truncateUtf8(input.question, maxChainGateQuestionBytes).value;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO agent_chain_gates(
         root_message_id,tenant_id,asked_by_alias,source_delivery_id,source_attempt,output_index,
         trace_id,question,correlation,origin
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
    [
      input.rootMessageId, row.recipient_tenant, row.recipient_alias, row.id, ack.attempt,
      outputIndex, row.trace_id, question, JSON.stringify(input.correlation),
      row.origin ? JSON.stringify(row.origin) : null
    ]
  );
  const gateId = inserted.rows[0]?.id;
  if (gateId === undefined) {
    // Lost the race (another open gate from the same root) or it is a repeated ACK for the
    // same output. In both cases the current gate is what rules.
    const current = await openChainGateFor(client, input.rootMessageId);
    return current;
  }
  await client.query(
    `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_chain.gate_opened','allow',$3,$4,$5,$6,$7::jsonb)`,
    [
      row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id,
      row.trace_id,
      JSON.stringify({
        gate_id: gateId,
        root_message_id: input.rootMessageId,
        source_attempt: ack.attempt,
        output_index: outputIndex,
        question_bytes: Buffer.byteLength(question, 'utf8')
      })
    ]
  );
  if (row.origin) {
    await client.query(
      `INSERT INTO adapter_outbox(
           tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
         ) VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
         ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
      [
        originRelayTenant(row), row.origin.adapter, `chain-gate:${gateId}`, row.request_id,
        row.message_id, row.id, row.trace_id, JSON.stringify(row.origin),
        JSON.stringify({
          relay_kind: 'ack',
          terminal: false,
          outcome: 'ack',
          progress_stage: 'gated',
          gate_id: gateId,
          result: {
            output: {
              reply: `${row.recipient_alias} necesita una respuesta tuya para seguir:\n\n${question}`,
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
            root_message_id: input.rootMessageId,
            gate_id: gateId
          }
        })
      ]
    );
  }
  return { id: gateId, question };
}

/**
 * Reserves one delegation from the root's fuel.
 *
 * The reservation IS the conditional UPDATE: when `WHERE delegations < cap` does not hold
 * no row comes back and the counter does NOT advance. A rejection does not consume budget,
 * and two concurrent ACKs of the same chain serialize on the row instead of racing past.
 */
export async function reserveRootDelegation(
  client: DatabaseClient,
  rootMessageId: string,
  cap: number
): Promise<boolean> {
  await client.query(
    `INSERT INTO agent_chain_progress(root_message_id) VALUES($1)
       ON CONFLICT(root_message_id) DO NOTHING`,
    [rootMessageId]
  );
  const reserved = await client.query(
    `UPDATE agent_chain_progress SET delegations=delegations+1
       WHERE root_message_id=$1 AND delegations<$2 RETURNING delegations`,
    [rootMessageId, cap]
  );
  return reserved.rowCount === 1;
}

/** Returns the fuel taken when the next step of the reservation did not fit. */
export async function releaseRootDelegation(
  client: DatabaseClient,
  rootMessageId: string
): Promise<void> {
  await client.query(
    `UPDATE agent_chain_progress SET delegations=delegations-1
       WHERE root_message_id=$1 AND delegations>0`,
    [rootMessageId]
  );
}

/**
 * Counts repeated (root, source, target) edges because ancestor paths cannot detect every
 * response-continuation loop.
 */
export async function reserveChainEdge(
  client: DatabaseClient,
  rootMessageId: string,
  sourceNode: string,
  targetNode: string,
  cap: number
): Promise<boolean> {
  const reserved = await client.query(
    `INSERT INTO agent_chain_edge_uses(root_message_id,source_node,target_node,uses)
       VALUES($1,$2,$3,1)
       ON CONFLICT(root_message_id,source_node,target_node) DO UPDATE
         SET uses=agent_chain_edge_uses.uses+1,last_used_at=now()
         WHERE agent_chain_edge_uses.uses<$4
       RETURNING uses`,
    [rootMessageId, sourceNode, targetNode, cap]
  );
  return reserved.rowCount === 1;
}

export async function insertAgentOutputRejection(
  client: DatabaseClient,
  row: DeliveryRow,
  ack: Ack,
  outputIndex: number,
  requestId: string,
  targetRefHash: string,
  bodyHash: string,
  hopCount: number,
  hopBudget: number,
  correlation: Record<string, unknown>,
  rejectionCode: AgentOutputRejectionCode,
  notice?: RejectionNotice,
  target?: string,
): Promise<void> {
  // The human-readable reason goes into the row's correlation, not a new column: that way
  // the chain's read model and any forensic reader find it without an extra migration, and the
  // row still does not store the body (only its hash), which is the rule of this table.
  const rejectionCorrelation = notice === undefined
    ? correlation
    : {
        ...correlation,
        rejection: {
          code: notice.code,
          reason: notice.reason,
          guidance: notice.guidance,
          ...(target === undefined ? {} : { target }),
        },
      };
  await client.query(
    `INSERT INTO agent_output_materializations(
         source_delivery_id,source_attempt,output_index,source_message_id,source_tenant,source_alias,
         target_ref_hash,body_hash,status,rejection_code,request_id,trace_id,hop_count,hop_budget,correlation
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'rejected',$9,$10,$11,$12,$13,$14::jsonb)
       ON CONFLICT(source_delivery_id,source_attempt,output_index) DO NOTHING`,
    [
      row.id, ack.attempt, outputIndex, row.message_id, row.recipient_tenant, row.recipient_alias,
      targetRefHash, bodyHash, rejectionCode, requestId, row.trace_id,
      hopCount, hopBudget, JSON.stringify(rejectionCorrelation)
    ]
  );
  await client.query(
    `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_output.materialize','deny',$3,$4,$5,$6,$7::jsonb)`,
    [
      row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id, row.trace_id,
      JSON.stringify({
        source_attempt: ack.attempt,
        output_index: outputIndex,
        rejection_code: rejectionCode,
        target_ref_hash: targetRefHash,
        body_hash: bodyHash,
        hop_count: hopCount,
        hop_budget: hopBudget,
        ...(notice === undefined ? {} : { rejection_notice: rejectionText(notice) })
      })
    ]
  );
}
