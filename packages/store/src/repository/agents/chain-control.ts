import { randomUUID } from 'node:crypto';
import type { Origin, Tenant } from '@cauce/protocol';
import { withTransaction } from '../../db.js';
import { uuidPattern } from './fanin.js';
import { postgresTextSafe } from '../deliveries.js';
import { StoreError } from '../errors.js';
import { insertDelivery, insertMessage } from '../messages/_insert.js';
import { truncateUtf8 } from '../observability.js';
import { objectRecord, visibleText } from '../outbox.js';
import { AgentChainMaterializationRepository } from './chain-control/materialization.js';
import { maxChainGateQuestionBytes } from './chain-control/policy.js';

export type { AgentOutputRejectionCode } from './chain-control/policy.js';

export abstract class AgentChainControlRepository extends AgentChainMaterializationRepository {
  /**
   * The VISIBLE list of pending questions to a person.
   *
   * It is the counterpart of the gate: decoupling the human wait from the bus so a queryable,
   * manageable listing is available to operators or authorized agents.
   *
   * Open entries come first, then recently resolved ones, so the list also serves as an
   * acknowledgment of "this was already answered".
   */
  async listChainGates(
    actorTenant: Tenant,
    actorAlias: string,
    options: { status?: 'open' | 'all'; limit?: number } = {}
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const limit = Number.isSafeInteger(options.limit) && (options.limit ?? 0) > 0
      ? Math.min(options.limit!, 500)
      : 200;
    const onlyOpen = options.status !== 'all';
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT gate.id,gate.root_message_id,gate.tenant_id,gate.asked_by_alias,gate.trace_id,
              gate.question,gate.status,gate.answer,gate.answered_at,gate.answered_by,
              gate.resume_delivery_id,gate.origin,gate.created_at,gate.updated_at,
              gate.source_delivery_id,
              (gate.correlation->>'hop_count')::integer AS hop_count,
              (gate.correlation->>'hop_budget')::integer AS hop_budget,
              extract(epoch FROM (now()-gate.created_at))::bigint AS waiting_seconds
       FROM agent_chain_gates gate
       WHERE (NOT $3::boolean OR gate.status='open')
         AND (gate.tenant_id=$1 OR EXISTS (
           SELECT 1 FROM acl_edges edge
           WHERE edge.from_tenant=$1 AND edge.to_tenant=gate.tenant_id
             AND edge.enabled AND edge.allow_read
         ))
         AND EXISTS (
           SELECT 1 FROM memberships membership
           WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         )
       ORDER BY (gate.status='open') DESC,gate.created_at DESC
       LIMIT $4`,
      [actorTenant, actorAlias, onlyOpen, limit]
    );
    return { items: result.rows };
  }

  /**
   * The human answers and the chain resumes.
   *
   * Emits EXACTLY ONE delivery, toward the agent that asked, with the suspended branch's
   * correlation restored: same root, same trace, same hop budget, and same visited path. That is
   * why resuming does not start a new chain, nor recover fuel already spent.
   *
   * `FOR UPDATE` on the gate row is the other side of the `FOR SHARE` taken by
   * `materializeAgentOutputs`: answering and delegating on the same root cannot cross each other.
   */
  async answerChainGate(
    gateId: string,
    answer: string,
    actorTenant: Tenant,
    actorAlias: string
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'route');
    if (!uuidPattern.test(gateId)) {
      throw new StoreError('invalid_input', 'gate id must be a uuid');
    }
    const text = postgresTextSafe(answer) ?? '';
    if (!visibleText(text)) {
      throw new StoreError('invalid_input', 'gate answer must be non-empty text');
    }
    const bounded = truncateUtf8(text, maxChainGateQuestionBytes).value;
    return withTransaction(this.pool, async (client) => {
      const gate = await client.query<{
        id: string;
        root_message_id: string;
        tenant_id: Tenant;
        asked_by_alias: string;
        trace_id: string;
        question: string;
        status: string;
        correlation: Record<string, unknown> | null;
        origin: Origin | null;
      }>(
        `SELECT id,root_message_id,tenant_id,asked_by_alias,trace_id,question,status,correlation,origin
         FROM agent_chain_gates WHERE id=$1 FOR UPDATE`,
        [gateId]
      );
      const row = gate.rows[0];
      if (!row) throw new StoreError('not_found', 'chain gate not found');
      if (row.status !== 'open') {
        throw new StoreError('conflict', `chain gate is already ${row.status}`);
      }
      const room = await client.query<{ room_id: string }>(
        `SELECT membership.room_id
         FROM memberships membership
         JOIN role_policies policy ON policy.role=membership.role
         JOIN tenants tenant ON tenant.id=membership.tenant_id
         JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
         WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
           AND tenant.enabled AND room.enabled AND policy.allow_route
         ORDER BY membership.room_id LIMIT 1`,
        [row.tenant_id, row.asked_by_alias]
      );
      const roomId = room.rows[0]?.room_id;
      if (!roomId) {
        throw new StoreError('invalid_actor', 'the agent that opened the gate has no routable room');
      }
      const gateCorrelation = objectRecord(row.correlation) ?? {};
      // One hop is subtracted on purpose. The stored correlation is what the CHILD of this branch
      // would have carried; resuming does not step down a level, it returns to the SAME agent.
      // Without the subtraction, each gate would burn one hop from the chain budget.
      const storedHop = typeof gateCorrelation.hop_count === 'number'
        && Number.isSafeInteger(gateCorrelation.hop_count)
        ? gateCorrelation.hop_count
        : 1;
      const correlation = {
        ...gateCorrelation,
        hop_count: Math.max(0, storedHop - 1),
        gate_id: row.id,
        gate_question: row.question,
        gate_answered_by: `${actorTenant}/${actorAlias}`
      };
      const requestId = randomUUID();
      const message = await insertMessage(client, {
        requestId,
        traceId: row.trace_id,
        tenantId: row.tenant_id,
        roomId,
        actorAlias: row.asked_by_alias,
        body: {
            type: 'agent.message',
            text: `Respuesta humana a tu pregunta pendiente.\n\nPregunta: ${row.question}\n\n`
              + `Respuesta de ${actorAlias}: ${bounded}\n\n`
              + 'Retomá la tarea con esto. No vuelvas a preguntar lo mismo.',
            from_alias: actorAlias,
            correlation
        },
        origin: row.origin ?? null,
        lane: 'batch',
        priority: 7,
        authSessionId: `chain-gate:${row.id}`,
        authChannel: 'chain-gate',
      });
      const resumeMessageId = message.rows[0]?.id;
      if (!resumeMessageId) throw new Error('gate resume message insert returned no id');
      const delivery = await insertDelivery(client, {
        messageId: resumeMessageId, recipientTenant: row.tenant_id, recipientAlias: row.asked_by_alias,
      });
      const resumeDeliveryId = delivery.rows[0]?.id;
      if (!resumeDeliveryId) throw new Error('gate resume delivery insert returned no id');
      await client.query(
        `INSERT INTO adapter_outbox(
           tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
         ) VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,NULL,$7::jsonb)
         ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
        [
          row.tenant_id, `chain-gate-resume:${row.id}`, requestId, resumeMessageId,
          resumeDeliveryId, row.trace_id,
          JSON.stringify({ recipient_alias: row.asked_by_alias, reason: 'delivery_available' })
        ]
      );
      await client.query(
        `UPDATE agent_chain_gates
         SET status='answered',answer=$2,answered_at=now(),answered_by=$3,
             resume_message_id=$4,resume_delivery_id=$5,updated_at=now()
         WHERE id=$1`,
        [row.id, bounded, `${actorTenant}/${actorAlias}`, resumeMessageId, resumeDeliveryId]
      );
      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'agent_chain.gate_answered','allow',$3,$4,$5,$6,$7::jsonb)`,
        [
          row.tenant_id, actorAlias, requestId, resumeMessageId, resumeDeliveryId, row.trace_id,
          JSON.stringify({
            gate_id: row.id,
            root_message_id: row.root_message_id,
            asked_by_alias: row.asked_by_alias,
            answered_by: `${actorTenant}/${actorAlias}`
          })
        ]
      );
      await client.query('SELECT pg_notify($1,$2)', [
        'cauce_delivery_wake',
        JSON.stringify({ tenant_id: row.tenant_id, alias: row.asked_by_alias })
      ]);
      return {
        gate_id: row.id,
        status: 'answered',
        resume_message_id: resumeMessageId,
        resume_delivery_id: resumeDeliveryId,
        recipient_tenant: row.tenant_id,
        recipient_alias: row.asked_by_alias
      };
    });
  }

  /**
   * Closes a gate without resuming anything. It is the release valve for a question that no
   * longer makes sense: without it, a poorly opened gate would leave its root suspended forever.
   */
  async cancelChainGate(
    gateId: string,
    actorTenant: Tenant,
    actorAlias: string
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'route');
    if (!uuidPattern.test(gateId)) {
      throw new StoreError('invalid_input', 'gate id must be a uuid');
    }
    const updated = await this.pool.query<{ id: string; root_message_id: string }>(
      `UPDATE agent_chain_gates SET status='cancelled',updated_at=now()
       WHERE id=$1 AND status='open' RETURNING id,root_message_id`,
      [gateId]
    );
    if (updated.rowCount !== 1) {
      throw new StoreError('conflict', 'chain gate is not open');
    }
    return { gate_id: gateId, status: 'cancelled' };
  }
}
