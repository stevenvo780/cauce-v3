import { isRfcUuid, parseBlobArtifactUri, type DeliveryState, type Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../../db.js';
import { grantBlobForDelivery } from '../../blob-entitlements.js';
import { reservedInternalMessageTypes } from '../../config.js';
import { insertDelivery, insertMessage } from '../../messages/_insert.js';
import {
  truncateUtf8, type AgentFaninDisposition, type DeliveryRow
} from '../../observability.js';
import { objectRecord, visibleText } from '../../outbox.js';
import { artifactRefs } from '../delegated-attachments.js';
import {
  agentFaninInstruction, agentFaninMaxAggregateBytes, agentFaninMaxResponseBytes,
  agentFaninRequestId, agentFaninWithheldText, agentResponseText
} from './helpers.js';
import { AgentResponseRepository } from './response.js';

async function mayCarryBlobToRoot(
  client: DatabaseClient, sourceTenant: string, targetTenant: string,
): Promise<boolean> {
  if (sourceTenant === targetTenant) return true;
  const result = await client.query(
    `SELECT 1 FROM acl_edges outbound JOIN acl_edges inbound
       ON inbound.from_tenant=$2 AND inbound.to_tenant=$1
     WHERE outbound.from_tenant=$1 AND outbound.to_tenant=$2
       AND outbound.enabled AND outbound.allow_route
       AND inbound.enabled AND inbound.allow_read
     LIMIT 1 FOR SHARE OF outbound,inbound`,
    [sourceTenant, targetTenant],
  );
  return result.rowCount === 1;
}

async function sourceCanReferenceBlob(
  client: DatabaseClient, tenant: string, alias: string, sha256: string,
): Promise<boolean> {
  const owned = await client.query(
    `SELECT 1 FROM blobs WHERE tenant_id=$1 AND sha256=$2 LIMIT 1 FOR KEY SHARE`,
    [tenant, sha256],
  );
  if (owned.rowCount === 1) return true;
  const granted = await client.query(
    `SELECT 1 FROM blob_delivery_grants
     WHERE target_tenant_id=$1 AND target_alias=$2 AND sha256=$3
     LIMIT 1 FOR SHARE`,
    [tenant, alias, sha256],
  );
  return granted.rowCount === 1;
}

export abstract class AgentFaninMaterializationRepository extends AgentResponseRepository {
  protected override rootMessageId(row: DeliveryRow): string | undefined {
    // Same provenance rule as the correlation inheritance: only a reserved internal body,
    // which no client can publish, may name a chain root. Otherwise a publisher could point
    // at another chain's root, take its fan-in advisory lock and suppress its own relay.
    const correlation = typeof row.body.type === 'string'
      && reservedInternalMessageTypes.has(row.body.type)
      ? objectRecord(row.body.correlation)
      : undefined;
    const correlatedRoot = typeof correlation?.root_message_id === 'string'
      ? correlation.root_message_id
      : undefined;
    if (correlatedRoot !== undefined && isRfcUuid(correlatedRoot)) return correlatedRoot;
    return isRfcUuid(row.message_id) ? row.message_id : undefined;
  }

  protected async materializeAgentFanin(
    client: DatabaseClient,
    rootMessageId: string | undefined
  ): Promise<AgentFaninDisposition> {
    if (!rootMessageId) return { hasFanout: false, scheduled: false };
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`agent-fanin:${rootMessageId}`]
    );

    const progress = await client.query<{
      expected: string;
      completed: string;
      responses_recorded: string;
      pending_responses: boolean;
    }>(
      `SELECT
         count(*)::text AS expected,
         count(*) FILTER (WHERE child.status IN ('done','failed','dead'))::text AS completed,
         count(*) FILTER (
           WHERE EXISTS (
             SELECT 1
             FROM audit_events response_audit
             WHERE response_audit.action='agent_output.response'
               AND response_audit.decision IN ('allow','deny')
               AND response_audit.metadata->>'child_delivery_id'=child.id::text
           )
         )::text AS responses_recorded,
         EXISTS (
           SELECT 1
           FROM messages response
           JOIN deliveries response_delivery ON response_delivery.message_id=response.id
           JOIN audit_events response_audit
             ON response_audit.message_id=response.id
            AND response_audit.delivery_id=response_delivery.id
            AND response_audit.action='agent_output.response'
            AND response_audit.decision='allow'
           WHERE response.body->>'type'='agent.response'
             AND response.body->'correlation'->>'root_message_id'=$1
             AND response_delivery.status NOT IN ('done','failed','dead')
         ) AS pending_responses
       FROM agent_output_materializations materialization
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       WHERE materialization.status='materialized'
         AND materialization.correlation->>'root_message_id'=$1`,
      [rootMessageId]
    );
    const expected = Number(progress.rows[0]?.expected ?? 0);
    const completed = Number(progress.rows[0]?.completed ?? 0);
    const responsesRecorded = Number(progress.rows[0]?.responses_recorded ?? 0);
    const pendingResponses = progress.rows[0]?.pending_responses === true;
    if (expected === 0) return { hasFanout: false, scheduled: false };
    if (completed !== expected || responsesRecorded !== expected || pendingResponses) {
      return { hasFanout: true, scheduled: false };
    }

    const root = await client.query<DeliveryRow>(
      `SELECT source.id,source.message_id,source.recipient_tenant,source.recipient_alias,
              source.status,source.attempt,source.max_attempts,source.last_ack_rank,
              source.consumer_instance_id,source.consumer_epoch,source.claim_token,source.ack_deadline_at,
              root_message.request_id,root_message.trace_id,root_message.tenant_id,root_message.room_id,
              root_message.actor_alias,root_message.body,root_message.lane,root_message.priority,
              root_message.origin,root_message.auth_session_id,root_message.auth_channel
       FROM agent_output_materializations materialization
       JOIN deliveries source ON source.id=materialization.source_delivery_id
       JOIN messages root_message ON root_message.id=source.message_id
       WHERE materialization.status='materialized'
         AND materialization.correlation->>'root_message_id'=$1
         AND materialization.source_message_id=$1::uuid
       ORDER BY source.id
       LIMIT 1
       FOR SHARE OF source,root_message`,
      [rootMessageId]
    );
    const rootRow = root.rows[0];
    if (!rootRow) throw new Error('fan-in root delivery is unavailable');

    const existing = await client.query(
      `SELECT 1 FROM adapter_outbox
       WHERE tenant_id=$1 AND adapter='gateway' AND idempotency_key=$2
       LIMIT 1`,
      [rootRow.recipient_tenant, `agent-fanin:${rootMessageId}`]
    );
    if (existing.rowCount) return { hasFanout: true, scheduled: true };

    const branchRows = await client.query<{
      output_index: number;
      target_tenant: Tenant;
      alias: string;
      child_delivery_id: string;
      outcome: DeliveryState;
      result: Record<string, unknown> | null;
      last_error: string | null;
      response_text: string | null;
      response_artifacts: unknown;
      response_denied: boolean;
      tenant_visible: boolean;
    }>(
      `SELECT materialization.output_index,materialization.target_tenant,
              materialization.target_alias AS alias,
              child.id AS child_delivery_id,child.status AS outcome,
              child.result,child.last_error,returned.response_text,
              returned.response_artifacts,COALESCE(returned.response_denied,false) AS response_denied,
              (materialization.target_tenant=$2 OR (
                EXISTS (
                  SELECT 1 FROM acl_edges read_edge
                  JOIN tenants reader ON reader.id=read_edge.from_tenant
                  JOIN tenants owner ON owner.id=read_edge.to_tenant
                  WHERE read_edge.from_tenant=$2 AND read_edge.to_tenant=materialization.target_tenant
                    AND read_edge.enabled AND read_edge.allow_read AND (reader.is_hub OR owner.is_hub)
                )
                AND EXISTS (
                  SELECT 1 FROM acl_edges route_edge
                  JOIN tenants sender ON sender.id=route_edge.from_tenant
                  JOIN tenants receiver ON receiver.id=route_edge.to_tenant
                  WHERE route_edge.from_tenant=materialization.target_tenant AND route_edge.to_tenant=$2
                    AND route_edge.enabled AND route_edge.allow_route AND (sender.is_hub OR receiver.is_hub)
                )
              )) AS tenant_visible
       FROM agent_output_materializations materialization
       JOIN deliveries source ON source.id=materialization.source_delivery_id
         AND source.recipient_tenant=$2 AND source.recipient_alias=$3
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       LEFT JOIN LATERAL (
         SELECT CASE
                  WHEN response_audit.decision='deny'
                    THEN 'Agent response denied: '
                      || COALESCE(response_audit.metadata->>'reason','authorization_unavailable')
                  ELSE response.body->>'text'
                END AS response_text,
                response_audit.decision='deny' AS response_denied,
                CASE WHEN response_audit.decision='allow'
                       AND response_audit.tenant_id=materialization.target_tenant
                       AND response_audit.actor_alias=materialization.target_alias
                       AND response_audit.metadata->>'source_delivery_id'
                           =materialization.source_delivery_id::text
                       AND response.tenant_id=materialization.target_tenant
                       AND response.actor_alias=materialization.target_alias
                       AND response.body->>'type'='agent.response'
                       AND response.body->>'from_alias'=materialization.target_alias
                       AND response.body->'correlation'->>'child_delivery_id'=child.id::text
                       AND response.body->'correlation'->>'response_to_delivery_id'
                           =materialization.source_delivery_id::text
                       AND response.body->'correlation'->>'parent_delivery_id'
                           =COALESCE(response_audit.metadata->>'continuation_delivery_id',child.id::text)
                       AND EXISTS (
                         SELECT 1 FROM deliveries response_delivery
                         WHERE response_delivery.id=response_audit.delivery_id
                           AND response_delivery.message_id=response.id
                           AND response_delivery.recipient_tenant=materialization.source_tenant
                           AND response_delivery.recipient_alias=materialization.source_alias
                       )
                     THEN response.body->'artifacts_v1'
                     ELSE NULL END AS response_artifacts
         FROM audit_events response_audit
         LEFT JOIN messages response ON response.id=response_audit.message_id
         WHERE response_audit.action='agent_output.response'
           AND response_audit.decision IN ('allow','deny')
           AND response_audit.metadata->>'child_delivery_id'=child.id::text
           -- La fila sintética de recordTerminalBranchesWithoutResponse existe para que la rama
           -- sea CONTABLE, no para hablar por ella: no hubo ninguna respuesta que denegar. Si se
           -- renderizara, el coordinador leería «Agent response denied» de una rama que nadie
           -- denegó, en vez del desenlace real que agentResponseText sí sabe contar (el
           -- last_error de la rama muerta, por ejemplo).
           AND response_audit.metadata->>'reason' IS DISTINCT FROM 'terminal_without_response'
           AND (
             response_audit.decision='deny'
             OR response.body->>'type'='agent.response'
           )
         ORDER BY response_audit.id DESC
         LIMIT 1
       ) returned ON true
       WHERE materialization.status='materialized'
         AND materialization.correlation->>'root_message_id'=$1
       ORDER BY materialization.hop_count,materialization.source_message_id,
                materialization.output_index,materialization.target_tenant,
                materialization.target_alias,child.id`,
      [rootMessageId, rootRow.recipient_tenant, rootRow.recipient_alias]
    );
    const branchExpected = branchRows.rows.length;
    const branchCompleted = branchRows.rows.filter(
      (branch) => ['done', 'failed', 'dead'].includes(branch.outcome)
    ).length;
    const boundedResponses = branchRows.rows.map((branch) => {
      if (!branch.tenant_visible && !branch.response_denied) {
        return {
          output_index: branch.output_index,
          tenant_id: branch.target_tenant,
          alias: branch.alias,
          delivery_id: branch.child_delivery_id,
          outcome: branch.outcome,
          untrusted_text: agentFaninWithheldText,
          truncated: false
        };
      }
      const sourceText = visibleText(branch.response_text)
        || agentResponseText(
          branch.alias,
          branch.outcome,
          branch.result ?? undefined,
          branch.last_error ?? undefined,
          undefined
        );
      const bounded = truncateUtf8(sourceText, agentFaninMaxResponseBytes);
      const artifacts = artifactRefs(branch.response_artifacts);
      return {
        output_index: branch.output_index,
        tenant_id: branch.target_tenant,
        alias: branch.alias,
        delivery_id: branch.child_delivery_id,
        outcome: branch.outcome,
        untrusted_text: bounded.value,
        truncated: bounded.truncated,
        ...(artifacts.length > 0 ? { artifacts } : {})
      };
    });
    const includedResponses = [...boundedResponses];
    const faninData = (): Record<string, unknown> => ({
      schema: 'cauce.agent_fanin_data.v1',
      trust: 'untrusted_branch_output',
      root_request_id: rootRow.request_id,
      root_message_id: rootMessageId,
      root_delivery_id: rootRow.id,
      expected: branchExpected,
      completed: branchCompleted,
      included_responses: includedResponses.length,
      responses: includedResponses,
      truncation: {
        max_response_bytes: agentFaninMaxResponseBytes,
        max_aggregate_bytes: agentFaninMaxAggregateBytes,
        truncated_responses: boundedResponses.filter((response) => response.truncated).length,
        omitted_responses: boundedResponses.length - includedResponses.length
      }
    });
    const faninBody = (): Record<string, unknown> => ({
      type: 'agent.fanin',
      text: agentFaninInstruction,
      expected: branchExpected,
      completed: branchCompleted,
      correlation: {
        root_request_id: rootRow.request_id,
        root_message_id: rootMessageId,
        root_delivery_id: rootRow.id
      },
      fanin_data_v1: faninData()
    });
    while (includedResponses.length > 0
      && Buffer.byteLength(JSON.stringify(faninBody()), 'utf8') > agentFaninMaxAggregateBytes) {
      includedResponses.pop();
    }
    let faninBodyPayload = faninBody();
    let faninDataPayload = objectRecord(faninBodyPayload.fanin_data_v1);
    if (Buffer.byteLength(JSON.stringify(faninBodyPayload), 'utf8') > agentFaninMaxAggregateBytes
      || !faninDataPayload) {
      throw new Error('fan-in body exceeds the configured size limit');
    }

    const requestId = agentFaninRequestId(rootMessageId);
    // Fan-in is coordinator-authored, so its room must contain that coordinator. The root room
    // may belong to another tenant and is reusable only within the same tenant. Resolve membership
    // as materializeAgentResponse does.
    const faninMembership = await client.query<{ room_id: string }>(
      `SELECT membership.room_id
       FROM memberships membership
       JOIN role_policies policy ON policy.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND policy.allow_route
       ORDER BY (membership.room_id=$3) DESC, membership.room_id LIMIT 1
       FOR SHARE OF membership,policy,tenant,room`,
      [rootRow.recipient_tenant, rootRow.recipient_alias, rootRow.room_id]
    );
    const faninRoomId = faninMembership.rows[0]?.room_id;
    if (!faninRoomId) return { hasFanout: true, scheduled: false };
    const message = await insertMessage(client, {
      requestId,
      traceId: rootRow.trace_id,
      tenantId: rootRow.recipient_tenant,
      roomId: faninRoomId,
      actorAlias: rootRow.recipient_alias,
      body: faninBodyPayload,
      origin: rootRow.origin ?? null,
      lane: 'batch',
        // Fan-in wakes the coordinator for the human's pending reply, so it inherits root priority.
        // This wake is part of the user's wait rather than inter-agent background traffic.
        // Idempotency permits one fan-in per root; nested roots are already agent-priority capped.
        // Only a first-level human request can retain human priority.
      priority: rootRow.priority,
      authSessionId: rootRow.auth_session_id ?? `fanin:${rootMessageId}`,
      authChannel: rootRow.auth_channel ?? rootRow.origin?.channel ?? 'agent-fanin',
    });
    const messageId = message.rows[0]?.id;
    if (!messageId) throw new Error('fan-in message insert returned no id');
    const delivery = await insertDelivery(client, {
      messageId, recipientTenant: rootRow.recipient_tenant, recipientAlias: rootRow.recipient_alias,
    });
    const deliveryId = delivery.rows[0]?.id;
    if (!deliveryId) throw new Error('fan-in delivery insert returned no id');
    let withheldBlobRefs = 0;
    const grantedBlobDigests = new Set<string>();
    for (const [index, response] of includedResponses.entries()) {
      const artifacts = response.artifacts;
      if (artifacts === undefined) continue;
      const canRoute = await mayCarryBlobToRoot(
        client, response.tenant_id, rootRow.recipient_tenant,
      );
      const retained = [];
      for (const artifact of artifacts) {
        const sha256 = parseBlobArtifactUri(artifact.uri);
        if (sha256 === undefined) {
          retained.push(artifact);
          continue;
        }
        const granted = canRoute && (grantedBlobDigests.has(sha256)
          ? await sourceCanReferenceBlob(client, response.tenant_id, response.alias, sha256)
          : await grantBlobForDelivery(client, {
            sha256,
            sourceTenant: response.tenant_id,
            sourceAlias: response.alias,
            targetTenant: rootRow.recipient_tenant,
            targetAlias: rootRow.recipient_alias,
            deliveryId,
          }));
        if (granted) {
          grantedBlobDigests.add(sha256);
          retained.push(artifact);
        }
        else withheldBlobRefs += 1;
      }
      if (retained.length !== artifacts.length) {
        includedResponses[index] = { ...response, artifacts: retained };
      }
    }
    if (withheldBlobRefs > 0) {
      faninBodyPayload = faninBody();
      faninDataPayload = objectRecord(faninBodyPayload.fanin_data_v1);
      if (!faninDataPayload) throw new Error('filtered fan-in body is invalid');
      await client.query('UPDATE messages SET body=$2::jsonb WHERE id=$1', [
        messageId, JSON.stringify(faninBodyPayload),
      ]);
    }
    await client.query(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
       ) VALUES($1,'gateway',$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
      [
        rootRow.recipient_tenant,
        'wake',
        `agent-fanin:${rootMessageId}`,
        requestId,
        messageId,
        deliveryId,
        rootRow.trace_id,
        rootRow.origin ? JSON.stringify(rootRow.origin) : null,
        JSON.stringify({ recipient_alias: rootRow.recipient_alias, reason: 'agent_fanin_available' })
      ]
    );
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_output.fanin','allow',$3,$4,$5,$6,$7::jsonb)`,
      [
        rootRow.recipient_tenant,
        rootRow.recipient_alias,
        requestId,
        messageId,
        deliveryId,
        rootRow.trace_id,
        JSON.stringify({
          root_request_id: rootRow.request_id,
          root_message_id: rootMessageId,
          root_delivery_id: rootRow.id,
          expected: branchExpected,
          completed: branchCompleted,
          included_responses: includedResponses.length,
          truncated_responses: boundedResponses.filter((response) => response.truncated).length,
          omitted_responses: boundedResponses.length - includedResponses.length,
          withheld_blob_refs: withheldBlobRefs,
          schema: faninDataPayload.schema,
          trust: faninDataPayload.trust
        })
      ]
    );
    await client.query('SELECT pg_notify($1,$2)', [
      'cauce_delivery_wake',
      JSON.stringify({ tenant_id: rootRow.recipient_tenant, alias: rootRow.recipient_alias })
    ]);
    return { hasFanout: true, scheduled: true };
  }
}
