import { clampAgentPriority, type Ack, type Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../../../db.js';
import {
  attachmentsFromArtifacts, carriedBodyHash, delegatedMessageBody
} from '../../delegated-attachments.js';
import { insertDelivery, insertMessage } from '../../../messages/_insert.js';
import type { DeliveryRow } from '../../../observability.js';
import type { ResolvedAgentOutputEntry } from '../policy.js';

interface PersistedAgentOutput {
  producedDeliveryId: string;
}

export async function persistAgentOutput(
  client: DatabaseClient,
  input: {
    row: DeliveryRow;
    ack: Ack;
    output: ResolvedAgentOutputEntry;
    sourceRoomId: string;
    targetTenant: Tenant;
    targetAlias: string;
    body: string;
    requestId: string;
    targetRefHash: string;
    bodyHash: string;
    correlation: Record<string, unknown>;
    hopCount: number;
    hopBudget: number;
    visitedPath: string[];
    visitedPathAvailable: boolean;
  }
): Promise<PersistedAgentOutput> {
  const carried = attachmentsFromArtifacts(input.output.artifacts, input.output.artifactsWithheld);
  const message = await insertMessage(client, {
    requestId: input.requestId,
    traceId: input.row.trace_id,
    tenantId: input.row.recipient_tenant,
    roomId: input.sourceRoomId,
    actorAlias: input.row.recipient_alias,
    body: delegatedMessageBody({
      type: 'agent.message',
      text: input.body,
      from_alias: input.row.recipient_alias,
      correlation: input.correlation
    }, carried),
    origin: input.row.origin ?? null,
    lane: 'batch',
    priority: clampAgentPriority(input.row.priority),
    authSessionId: input.row.auth_session_id
      ?? `delivery:${input.row.id}:attempt:${String(input.ack.attempt)}`,
    authChannel: input.row.auth_channel ?? input.row.origin?.channel ?? 'agent-output',
  });
  const messageId = message.rows[0]?.id;
  if (!messageId) throw new Error('agent output message insert returned no id');
  const delivery = await insertDelivery(client, {
    messageId,
    recipientTenant: input.targetTenant,
    recipientAlias: input.targetAlias,
  });
  const producedDeliveryId = delivery.rows[0]?.id;
  if (!producedDeliveryId) throw new Error('agent output delivery insert returned no id');
  await client.query(
    `INSERT INTO adapter_outbox(
       tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
     ) VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,NULL,$7::jsonb)`,
    [
      input.targetTenant,
      `agent-output:${input.row.id}:${String(input.ack.attempt)}:${String(input.output.index)}`,
      input.requestId,
      messageId,
      producedDeliveryId,
      input.row.trace_id,
      JSON.stringify({ recipient_alias: input.targetAlias, reason: 'delivery_available' })
    ]
  );
  await client.query(
    `INSERT INTO agent_output_materializations(
       source_delivery_id,source_attempt,output_index,source_message_id,source_tenant,source_alias,
       target_tenant,target_alias,target_ref_hash,body_hash,status,produced_message_id,
       produced_delivery_id,request_id,trace_id,hop_count,hop_budget,correlation
       ${input.visitedPathAvailable ? ',visited_path' : ''}
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'materialized',$11,$12,$13,$14,$15,$16,$17::jsonb
       ${input.visitedPathAvailable ? ',$18::text[]' : ''})`,
    [
      input.row.id, input.ack.attempt, input.output.index, input.row.message_id,
      input.row.recipient_tenant, input.row.recipient_alias, input.targetTenant, input.targetAlias,
      input.targetRefHash, carriedBodyHash(input.bodyHash, carried), messageId, producedDeliveryId,
      input.requestId, input.row.trace_id, input.hopCount, input.hopBudget,
      JSON.stringify(input.correlation), ...(input.visitedPathAvailable ? [input.visitedPath] : [])
    ]
  );
  await client.query(
    `INSERT INTO audit_events(
       tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
     ) VALUES($1,$2,'agent_output.materialize','allow',$3,$4,$5,$6,$7::jsonb)`,
    [
      input.row.recipient_tenant, input.row.recipient_alias, input.requestId, messageId,
      producedDeliveryId, input.row.trace_id,
      JSON.stringify({
        source_delivery_id: input.row.id,
        source_attempt: input.ack.attempt,
        output_index: input.output.index,
        target_tenant: input.targetTenant,
        target_alias: input.targetAlias,
        hop_count: input.hopCount,
        hop_budget: input.hopBudget,
        ...(carried.rejectedNames > 0
          ? { rejected_attachment_names: carried.rejectedNames }
          : {})
      })
    ]
  );
  await client.query('SELECT pg_notify($1,$2)', [
    'cauce_delivery_wake',
    JSON.stringify({ tenant_id: input.targetTenant, alias: input.targetAlias })
  ]);
  return { producedDeliveryId };
}
