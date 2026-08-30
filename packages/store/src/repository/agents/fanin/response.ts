import { clampAgentPriority, type DeliveryState, type Tenant } from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "error" */
import type { DatabaseClient } from '../../../db.js';
import { isLiteralTrue } from '../../../runtime-values.js';
import { postgresTextSafe } from '../../deliveries.js';
import { insertDelivery, insertMessage } from '../../messages/_insert.js';
import {
  truncateUtf8, type AgentResponseDisposition, type ChainPolicy, type DeliveryRow
} from '../../observability.js';
import { objectRecord } from '../../outbox.js';
import {
  agentResponseRequestId, agentResponseText, aggregatedFailureText, failureSignature,
  lateResultText, maxAgentResponseTextBytes, uuidPattern, type FailureNoticeReservation
} from './helpers.js';
import { AgentProgressRepository } from './progress.js';

export abstract class AgentResponseRepository extends AgentProgressRepository {
  protected async materializeAgentResponse(
    client: DatabaseClient,
    row: DeliveryRow,
    attempt: number,
    outcome: DeliveryState,
    policy: ChainPolicy,
    result: Record<string, unknown> | undefined,
    error?: string,
    errorCode?: string,
    late?: { previousStatus: DeliveryState }
  ): Promise<AgentResponseDisposition> {
    const responseCorrelation = row.body.type === 'agent.response'
      ? objectRecord(row.body.correlation)
      : undefined;
    const claimedResponseToDeliveryId = typeof responseCorrelation?.response_to_delivery_id === 'string'
      && uuidPattern.test(responseCorrelation.response_to_delivery_id)
      ? responseCorrelation.response_to_delivery_id
      : null;
    const trustedResponse = claimedResponseToDeliveryId === null
      ? false
      : (await client.query(
        `SELECT 1 FROM audit_events
         WHERE message_id=$1 AND delivery_id=$2
           AND action='agent_output.response' AND decision='allow'
         LIMIT 1 FOR SHARE`,
        [row.message_id, row.id]
      )).rowCount === 1;
    const responseToDeliveryId = trustedResponse ? claimedResponseToDeliveryId : null;
    const parent = await client.query<{
      source_delivery_id: string;
      source_attempt: number;
      source_message_id: string;
      source_tenant: Tenant;
      source_alias: string;
      hop_count: number;
      hop_budget: number;
      correlation: Record<string, unknown>;
    }>(
      `SELECT materialization.source_delivery_id,materialization.source_attempt,
              materialization.source_message_id,
              materialization.source_tenant,materialization.source_alias,
              materialization.hop_count,materialization.hop_budget,materialization.correlation
       FROM agent_output_materializations materialization
       WHERE (
           ($1::uuid IS NULL AND materialization.produced_message_id=$2)
           OR ($1::uuid IS NOT NULL AND materialization.produced_delivery_id=$1::uuid)
         )
         AND materialization.status='materialized'
         AND materialization.target_tenant=$3
         AND materialization.target_alias=$4
       LIMIT 1
       FOR SHARE OF materialization`,
      [responseToDeliveryId, row.message_id, row.recipient_tenant, row.recipient_alias]
    );
    const relationship = parent.rows[0];
    if (!relationship) return 'not_child';

    // Verify the recipient agent has exactly one enabled membership in its room.
    // Counted via rowCount for compatibility with FOR SHARE.
    const sourceMembership = await client.query<{ room_id: string }>(
      `SELECT membership.room_id
       FROM memberships membership
       JOIN role_policies policy ON policy.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND policy.allow_route
       ORDER BY membership.room_id
       FOR SHARE OF membership,policy,tenant,room`,
      [row.recipient_tenant, row.recipient_alias]
    );
    const membershipCount = sourceMembership.rowCount ?? sourceMembership.rows.length;
    if (membershipCount !== 1) {
      // Zero memberships means recipient is disabled/deleted; >1 means ambiguous identity.
      // Reject materialization to avoid silent cross-tenant routing errors.
      await this.insertAgentResponseDenial(
        client, row, relationship, responseToDeliveryId, 'source_membership_unavailable', policy
      );
      return 'denied';
    }
    const childRoomId = sourceMembership.rows[0]?.room_id;
    if (!childRoomId) {
      await this.insertAgentResponseDenial(
        client, row, relationship, responseToDeliveryId, 'source_membership_unavailable', policy
      );
      return 'denied';
    }

    const targetMembership = await client.query(
      `SELECT 1
       FROM memberships membership
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled
       ORDER BY membership.room_id LIMIT 1
       FOR SHARE OF membership,tenant,room`,
      [relationship.source_tenant, relationship.source_alias]
    );
    if (targetMembership.rowCount !== 1) {
      await this.insertAgentResponseDenial(
        client, row, relationship, responseToDeliveryId, 'target_membership_unavailable', policy
      );
      return 'denied';
    }

    if (row.recipient_tenant !== relationship.source_tenant) {
      const reverseEdge = await client.query(
        `SELECT 1
         FROM acl_edges edge
         JOIN tenants source ON source.id=edge.from_tenant
         JOIN tenants target ON target.id=edge.to_tenant
         WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
           AND edge.enabled AND edge.allow_route AND (source.is_hub OR target.is_hub)
         FOR SHARE OF edge,source,target`,
        [row.recipient_tenant, relationship.source_tenant]
      );
      if (reverseEdge.rowCount !== 1) {
        await this.insertAgentResponseDenial(
          client, row, relationship, responseToDeliveryId, 'reverse_acl_unavailable', policy
        );
        return 'denied';
      }
    }

    const requestId = agentResponseRequestId(
      row.id, attempt, late === undefined ? 'agent-response' : 'agent-response-late'
    );
    // Same server-derived value as the audit below: the delegated branch this reply closes.
    // The coordinator needs it to tell two branches delegated to the same alias apart when
    // it decides which raw branch evidence its own synthesis already covers.
    const childDeliveryId = responseToDeliveryId ?? row.id;

    // Failure coalescing. Everything above (kinship, memberships, reverse ACL) was already
    // verified: the notice being folded is one the parent HAD the right to receive, never a denied
    // one, so coalescing cannot hide an authorization problem.
    const reservation = outcome === 'done'
      ? undefined
      : await this.reserveFailureNotice(
        client, row, relationship, attempt, childDeliveryId, outcome, policy, error, errorCode
      );
    if (reservation && !reservation.emit) {
      await this.recordCoalescedFailure(
        client, row, relationship, reservation, attempt, childDeliveryId, outcome
      );
      return 'coalesced';
    }

    const correlation = {
      ...relationship.correlation,
      parent_request_id: row.request_id,
      parent_message_id: row.message_id,
      parent_delivery_id: row.id,
      parent_attempt: attempt,
      response_to_delivery_id: relationship.source_delivery_id,
      response_to_message_id: relationship.source_message_id,
      child_delivery_id: childDeliveryId,
      hop_count: relationship.hop_count,
      hop_budget: relationship.hop_budget,
      // The parent must be able to move from notice to detail without guessing. With notice_id it
      // resolves agent_failure_notice_events; total_failures and coalesced_failures tell it how
      // much did NOT reach it as a delivery.
      ...(reservation === undefined ? {} : {
        failure_coalescing: {
          notice_id: reservation.noticeId,
          signature: reservation.signature,
          window_seconds: policy.failureCoalesceWindowSeconds,
          window_started_at: reservation.windowStartedAt,
          total_failures: reservation.totalFailures,
          coalesced_failures: reservation.coalescedFailures
        }
      }),
      // The parent already received a failure notice for this same branch. This tells it, without
      // having to infer it from the text, that what it is reading replaces it.
      ...(late === undefined ? {} : {
        late_result: {
          superseded_outcome: late.previousStatus,
          supersedes_request_id: agentResponseRequestId(row.id, attempt)
        }
      })
    };
    const baseText = lateResultText(
      agentResponseText(row.recipient_alias, outcome, result, error, errorCode),
      row.recipient_alias,
      late
    );
    const message = await insertMessage(client, {
      requestId,
      traceId: row.trace_id,
      tenantId: row.recipient_tenant,
      roomId: childRoomId,
      actorAlias: row.recipient_alias,
      body: {
          type: 'agent.response',
          text: aggregatedFailureText(baseText, row.recipient_alias, reservation),
          from_alias: row.recipient_alias,
          outcome,
          correlation
      },
      origin: row.origin ?? null,
        // Same criterion as materializeAgentOutputs: the return of a delegation is traffic
        // between agents, not the person's conversation. It goes to the background lane.
      lane: 'batch',
        // Cap agent-return priority so old machine traffic cannot compete with new human traffic.
      priority: clampAgentPriority(row.priority),
      authSessionId: row.auth_session_id ?? `delivery:${row.id}:attempt:${String(attempt)}`,
      authChannel: row.auth_channel ?? row.origin?.channel ?? 'agent-response',
    });
    const responseMessageId = message.rows[0]?.id;
    if (!responseMessageId) throw new Error('agent response message insert returned no id');
    const delivery = await insertDelivery(client, {
      messageId: responseMessageId,
      recipientTenant: relationship.source_tenant,
      recipientAlias: relationship.source_alias,
    });
    const responseDeliveryId = delivery.rows[0]?.id;
    if (!responseDeliveryId) throw new Error('agent response delivery insert returned no id');
    if (reservation) {
      // Emitted and coalesced failures share one ledger.
      await this.bindFailureNoticeEvent(
        client, row.id, attempt, reservation.noticeId, false, responseMessageId
      );
      await client.query(
        `UPDATE agent_failure_notices
         SET last_notice_message_id=$2,last_notice_delivery_id=$3,last_notice_base_text=$4,
             updated_at=now()
         WHERE id=$1`,
        [reservation.noticeId, responseMessageId, responseDeliveryId, baseText]
      );
    }
    await client.query(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
       ) VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [
        relationship.source_tenant,
        // Same namespace as `requestId`: the late notice of the SAME attempt must be able to
        // coexist with the row that already wrote the death notice. This INSERT carries no
        // `ON CONFLICT`, so a collision would not be a silent duplicate but the abort of the
        // whole ACK transaction.
        `${late === undefined ? 'agent-response' : 'agent-response-late'}:${row.id}:${String(attempt)}`,
        requestId,
        responseMessageId,
        responseDeliveryId,
        row.trace_id,
        row.origin ? JSON.stringify(row.origin) : null,
        JSON.stringify({ recipient_alias: relationship.source_alias, reason: 'agent_response_available' })
      ]
    );
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_output.response','allow',$3,$4,$5,$6,$7::jsonb)`,
      [
        row.recipient_tenant,
        row.recipient_alias,
        requestId,
        responseMessageId,
        responseDeliveryId,
        row.trace_id,
        JSON.stringify({
          // A continuation delivery completes the original delegated child,
          // not the synthetic agent.response delivery that resumed it. This
          // keeps fan-in accounting attached to the logical branch.
          child_delivery_id: childDeliveryId,
          ...(responseToDeliveryId === null ? {} : { continuation_delivery_id: row.id }),
          child_attempt: attempt,
          source_delivery_id: relationship.source_delivery_id,
          target_tenant: relationship.source_tenant,
          target_alias: relationship.source_alias,
          outcome,
          ...(late === undefined
            ? {}
            : { late_result: true, superseded_outcome: late.previousStatus })
        })
      ]
    );
    await client.query('SELECT pg_notify($1,$2)', [
      'cauce_delivery_wake',
      JSON.stringify({ tenant_id: relationship.source_tenant, alias: relationship.source_alias })
    ]);
    // A branch that returns while every sibling is already terminal is immediately followed
    // by the fan-in or the final relay, so announcing it would only add a message the
    // supersede machinery is about to kill.
    const siblings = await client.query<{ open: string }>(
      `SELECT count(*) FILTER (WHERE child.status NOT IN ('done','failed','dead'))::text AS open
       FROM agent_output_materializations materialization
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       WHERE materialization.source_delivery_id=$1 AND materialization.source_attempt=$2
         AND materialization.status='materialized'`,
      [relationship.source_delivery_id, relationship.source_attempt]
    );
    const openSiblings = Number(siblings.rows[0]?.open ?? 0);
    if (openSiblings > 0) {
      await this.insertProgressRelay(
        client, row, attempt, policy, this.relationshipRoot(relationship), 'returned',
        `${row.recipient_alias} respondió a ${relationship.source_alias};`
        + ` quedan ${String(openSiblings)} rama(s) en curso.`
      );
    }
    return 'returned';
  }

  private relationshipRoot(relationship: { correlation: Record<string, unknown> }): string | undefined {
    const root = relationship.correlation.root_message_id;
    return typeof root === 'string' && uuidPattern.test(root) ? root : undefined;
  }

  /**
   * Decide and moves counters in one statement. The ON CONFLICT row lock serializes concurrent
   * ACKs for the same bucket; SELECT followed by UPDATE would let both emit.
   * The decision and counter movement cannot be split across statements.
   * PostgreSQL `now()` is the transaction-start instant, so concurrent deaths in one transaction
   * window belong to the same newly opened bucket.
   */
  private async reserveFailureNotice(
    client: DatabaseClient,
    row: DeliveryRow,
    relationship: {
      source_delivery_id: string;
      source_message_id: string;
      source_tenant: Tenant;
      source_alias: string;
      correlation: Record<string, unknown>;
    },
    attempt: number,
    childDeliveryId: string,
    outcome: DeliveryState,
    policy: ChainPolicy,
    error: string | undefined,
    errorCode: string | undefined
  ): Promise<FailureNoticeReservation | undefined> {
    if (!policy.failureCoalesceEnabled || policy.failureCoalesceWindowSeconds < 1) return undefined;
    // Without a root declared by the store, the parent's return is still a valid grouper: it is
    // the concrete turn that opened those branches. Coalescing is never skipped for lack of root.
    const root = this.relationshipRoot(relationship) ?? relationship.source_message_id;
    if (!uuidPattern.test(root)) return undefined;
    const signature = failureSignature(outcome, error, errorCode);

    // Retry of the SAME ACK: the (delivery, attempt) key of the ledger is already taken, so this
    // failure was already counted. No counter is moved again and nothing is re-emitted.
    const claimed = await client.query(
      `INSERT INTO agent_failure_notice_events(
         ack_delivery_id,ack_attempt,child_delivery_id,child_tenant,child_alias,outcome,error,error_code
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (ack_delivery_id,ack_attempt) DO NOTHING`,
      [row.id, attempt, childDeliveryId, row.recipient_tenant, row.recipient_alias, outcome,
        postgresTextSafe(error) ?? null, postgresTextSafe(errorCode) ?? null]
    );
    if (claimed.rowCount !== 1) return undefined;

    const reserved = await client.query<{
      id: string;
      total_failures: number;
      notices_emitted: number;
      window_started_at: Date | string;
      last_failure_emitted: boolean;
      last_notice_message_id: string | null;
      last_notice_delivery_id: string | null;
      last_notice_base_text: string | null;
    }>(
      `INSERT INTO agent_failure_notices(
         root_message_id,parent_tenant,parent_alias,child_tenant,child_alias,failure_signature,
         window_started_at,window_expires_at,notices_emitted,total_failures,last_failure_emitted
       ) VALUES($1,$2,$3,$4,$5,$6,now(),now()+$7*interval '1 second',1,1,true)
       ON CONFLICT ON CONSTRAINT agent_failure_notices_key DO UPDATE SET
         total_failures=agent_failure_notices.total_failures+1,
         notices_emitted=agent_failure_notices.notices_emitted
           +CASE WHEN agent_failure_notices.window_expires_at<=now() THEN 1 ELSE 0 END,
         window_started_at=CASE WHEN agent_failure_notices.window_expires_at<=now()
           THEN now() ELSE agent_failure_notices.window_started_at END,
         window_expires_at=CASE WHEN agent_failure_notices.window_expires_at<=now()
           THEN now()+$7*interval '1 second' ELSE agent_failure_notices.window_expires_at END,
         last_failure_emitted=(agent_failure_notices.window_expires_at<=now()),
         updated_at=now()
       RETURNING id::text,total_failures,notices_emitted,window_started_at,last_failure_emitted,
                 last_notice_message_id::text,last_notice_delivery_id::text,last_notice_base_text`,
      [root, relationship.source_tenant, relationship.source_alias, row.recipient_tenant,
        row.recipient_alias, signature, policy.failureCoalesceWindowSeconds]
    );
    const bucket = reserved.rows[0];
    if (!bucket) return undefined;
    const windowStartedAt = bucket.window_started_at instanceof Date
      ? bucket.window_started_at.toISOString()
      : bucket.window_started_at;
    // Folding against a notice that does not exist would be silence, not coalescing: if for any
    // reason the bucket has no earlier message to point at, this failure travels.
    const emit = isLiteralTrue(bucket.last_failure_emitted) || bucket.last_notice_message_id === null;
    return {
      noticeId: bucket.id,
      emit,
      totalFailures: bucket.total_failures,
      // How many failures from this bucket NEVER traveled with their own delivery. Holds both on
      // emit (those left silent in the window that just closed) and on fold (those plus the
      // current one), because it is a subtraction against the deliveries actually produced and
      // not a separate counter that could drift.
      coalescedFailures: Math.max(0, bucket.total_failures - bucket.notices_emitted),
      windowStartedAt,
      lastNoticeMessageId: bucket.last_notice_message_id,
      lastNoticeDeliveryId: bucket.last_notice_delivery_id,
      lastNoticeBaseText: bucket.last_notice_base_text,
      signature
    };
  }

  /**
   * A coalesced failure emits no message, delivery, outbox or relay. It still records the raw
   * ledger event and `agent_output.response`: fan-in counts that audit by child_delivery_id and
   * both records remain required even though no relay is emitted.
   * would otherwise wait forever.
   */
  private async recordCoalescedFailure(
    client: DatabaseClient,
    row: DeliveryRow,
    relationship: {
      source_delivery_id: string;
      source_tenant: Tenant;
      source_alias: string;
    },
    reservation: FailureNoticeReservation,
    attempt: number,
    childDeliveryId: string,
    outcome: DeliveryState
  ): Promise<void> {
    await this.bindFailureNoticeEvent(
      client, row.id, attempt, reservation.noticeId, true, reservation.lastNoticeMessageId
    );
    await this.refreshStandingFailureNotice(client, row.recipient_alias, reservation);
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_output.response','allow',$3,$4,$5,$6,$7::jsonb)`,
      [
        row.recipient_tenant,
        row.recipient_alias,
        row.request_id,
        // The aggregated notice message covering this failure: it is what makes the fan-in
        // summary show the aggregated text for this branch instead of an empty cell.
        reservation.lastNoticeMessageId,
        row.id,
        row.trace_id,
        JSON.stringify({
          child_delivery_id: childDeliveryId,
          child_attempt: attempt,
          source_delivery_id: relationship.source_delivery_id,
          target_tenant: relationship.source_tenant,
          target_alias: relationship.source_alias,
          outcome,
          coalesced: true,
          failure_notice_id: reservation.noticeId,
          failure_signature: reservation.signature,
          coalesced_into_message_id: reservation.lastNoticeMessageId,
          total_failures: reservation.totalFailures
        })
      ]
    );
  }

  /**
   * Rewrite only a still-pending notice with its aggregate count. The delivery row lock excludes
   * a concurrent claim while the first notice is still unread.
   * This preserves immediate notification while keeping unread aggregate content accurate;
   * once claimed, the notice is immutable and its count remains in the ledger
   * and the next notice.
   */
  private async refreshStandingFailureNotice(
    client: DatabaseClient,
    childAlias: string,
    reservation: FailureNoticeReservation
  ): Promise<void> {
    const { lastNoticeMessageId, lastNoticeDeliveryId, lastNoticeBaseText } = reservation;
    if (!lastNoticeMessageId || !lastNoticeDeliveryId || lastNoticeBaseText === null) return;
    const standing = await client.query<{ status: DeliveryState }>(
      'SELECT status FROM deliveries WHERE id=$1 FOR UPDATE', [lastNoticeDeliveryId]
    );
    if (standing.rows[0]?.status !== 'pending') return;
    const text = truncateUtf8(
      aggregatedFailureText(lastNoticeBaseText, childAlias, reservation), maxAgentResponseTextBytes
    ).value;
    await client.query(
      `UPDATE messages
       SET body=jsonb_set(
         jsonb_set(body,'{text}',to_jsonb($2::text),true),
         '{correlation,failure_coalescing}',$3::jsonb,true)
       WHERE id=$1`,
      [
        lastNoticeMessageId,
        text,
        JSON.stringify({
          notice_id: reservation.noticeId,
          signature: reservation.signature,
          total_failures: reservation.totalFailures,
          coalesced_failures: reservation.coalescedFailures,
          window_started_at: reservation.windowStartedAt
        })
      ]
    );
  }

  /**
   * Bind the pre-reserved (ack_delivery_id, ack_attempt) ledger row to its bucket and notice.
   */
  private async bindFailureNoticeEvent(
    client: DatabaseClient,
    ackDeliveryId: string,
    ackAttempt: number,
    noticeId: string,
    coalesced: boolean,
    noticeMessageId: string | null
  ): Promise<void> {
    await client.query(
      `UPDATE agent_failure_notice_events
       SET notice_id=$3,coalesced=$4,notice_message_id=$5
       WHERE ack_delivery_id=$1 AND ack_attempt=$2`,
      [ackDeliveryId, ackAttempt, noticeId, coalesced, noticeMessageId]
    );
  }

  private async insertAgentResponseDenial(
    client: DatabaseClient,
    row: DeliveryRow,
    relationship: {
      source_delivery_id: string;
      source_tenant: Tenant;
      source_alias: string;
      correlation: Record<string, unknown>;
    },
    responseToDeliveryId: string | null,
    reason: 'source_membership_unavailable' | 'target_membership_unavailable' | 'reverse_acl_unavailable',
    policy: ChainPolicy
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_output.response','deny',$3,$4,$5,$6,$7::jsonb)`,
      [
        row.recipient_tenant,
        row.recipient_alias,
        row.request_id,
        row.message_id,
        row.id,
        row.trace_id,
        JSON.stringify({
          reason,
          child_delivery_id: responseToDeliveryId ?? row.id,
          ...(responseToDeliveryId === null ? {} : { continuation_delivery_id: row.id }),
          source_delivery_id: relationship.source_delivery_id,
          target_tenant: relationship.source_tenant,
          target_alias: relationship.source_alias
        })
      ]
    );
    await this.insertProgressRelay(
      client, row, row.attempt, policy, this.relationshipRoot(relationship), 'denied',
      `${row.recipient_alias} no pudo devolver su respuesta a ${relationship.source_alias}: ${reason}.`
    );
  }
}
