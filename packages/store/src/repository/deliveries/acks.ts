import type { Ack, DeliveryState, ProfileRuntimeAdoptionEvidence, Tenant } from '@cauce/protocol';
import { isAmbiguousAckErrorCode } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withTransaction } from '../../db.js';
import { StoreError } from '../errors.js';
import { terminal } from '../messages.js';
import { textualReply } from '../outbox.js';
import {
  deliveryLeaseCapMs,
  type AgentResponseDisposition,
  type ChainPolicy,
  type DeliveryLeaseCap,
  type DeliveryRow,
  type LateRelayDisposition,
} from '../observability.js';
import {
  ackRank,
  agentNotifyEntries,
  agentOutputEntries,
  postgresJsonSafe,
  postgresTextSafe,
  profileRuntimeAdoptionEvidence,
  sanitizedAckResult,
  type AckResult,
  type AgentNotifyEntry,
  type AgentOutputEntry,
  type AgentOutputOutcome,
  type DelegationMaterialization,
  type DelegationRejection,
  type LateClaimProvenance,
  type LateResultRow,
  type OpenChainGate,
} from './contracts.js';
import { DeliveryClaimsRepository } from './claims.js';

export abstract class DeliveryAcksRepository extends DeliveryClaimsRepository {
  protected abstract recordProfileRuntimeAdoption(client: DatabaseClient, tenantId: Tenant, alias: string, row: DeliveryRow, ack: Ack, evidence: ProfileRuntimeAdoptionEvidence | undefined): Promise<boolean>;
  protected abstract delegationFeedbackForAck(client: DatabaseClient, deliveryId: string, attempt: number): Promise<Pick<AckResult, 'delegation_rejections' | 'delegation_materializations'>>;
  protected abstract materializeAgentOutputs(client: DatabaseClient, row: DeliveryRow, ack: Ack, outputs: AgentOutputEntry[], policy: ChainPolicy): Promise<AgentOutputOutcome>;
  protected abstract insertAck(client: DatabaseClient, row: DeliveryRow, ack: Ack, applied: boolean, persistedResult: Record<string, unknown> | undefined, renewal?: boolean): Promise<void>;
  protected abstract materializeAgentNotifications(client: DatabaseClient, row: DeliveryRow, ack: Ack, entries: AgentNotifyEntry[], ambiguousExecution: boolean): Promise<{ allowed: number; denied: number; errors: number }>;
  /**
   * Processes the ACK of a delivery, validating exclusivity fences, lease limits, and
   * delegating to `lateTerminalSalvage` if the result is terminal but exclusivity has expired.
   */
  async ackDelivery(
    deliveryId: string,
    tenantId: Tenant,
    alias: string,
    ack: Ack,
    ackDeadlineMs = 30_000,
    leaseCap: DeliveryLeaseCap = {}
  ): Promise<AckResult> {
    if (!ack.claim_token || !ack.attempt) {
      throw new StoreError('fenced', 'ACK requires claim_token and positive attempt');
    }
    if (!Number.isSafeInteger(ackDeadlineMs) || ackDeadlineMs <= 0) {
      throw new StoreError('conflict', 'ACK deadline must be a positive integer');
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const selected = await client.query<
        DeliveryRow & LateResultRow & { claim_live: boolean; execution_started: boolean }
      >(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,d.max_attempts,
                d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,d.claim_token,d.ack_deadline_at,
                d.late_result_at,d.cancelled_at,
                (d.ack_deadline_at>now()) AS claim_live,
                (d.execution_started_at IS NOT NULL) AS execution_started,
                 m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,m.priority,m.origin,
                 m.auth_session_id,m.auth_channel
         FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.id=$1 AND d.recipient_tenant=$2 AND d.recipient_alias=$3 FOR UPDATE OF d`,
        [deliveryId, tenantId, alias]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'delivery not found for consumer');
      const safeAckResult = postgresJsonSafe(ack.result) as Record<string, unknown> | undefined;
      const outputs = agentOutputEntries(safeAckResult);
      const notifications = agentNotifyEntries(safeAckResult);
      const runtimeAdoption = profileRuntimeAdoptionEvidence(safeAckResult);
      const persistedResult = sanitizedAckResult(safeAckResult);
      const repeated = await client.query<{
        delivery_id: string;
        status: Ack['status'];
        instance_id: string;
        epoch: string;
        claim_token: string;
        attempt: number;
        applied: boolean;
      }>(
        `SELECT delivery_id,status,instance_id,epoch,claim_token,attempt,applied
         FROM delivery_acks WHERE event_id=$1 LIMIT 1`,
        [ack.event_id]
      );
      const repeatedAck = repeated.rows[0];
      if (repeatedAck) {
        const exactEvent = repeatedAck.delivery_id === deliveryId
          && repeatedAck.status === ack.status
          && repeatedAck.instance_id === ack.instance_id
          && Number(repeatedAck.epoch) === ack.epoch
          && repeatedAck.claim_token === ack.claim_token
          && repeatedAck.attempt === ack.attempt;
        if (!exactEvent) {
          return {
            delivery_id: deliveryId,
            status: row.status,
            applied: false,
            receipt: 'ownership_lost',
          };
        }
        // Exact terminal/accepted replays end here; `started` continues only with live claim
        // and lease. That receipt can serve the client as fresh proof of ownership.
        if (repeatedAck.applied && ack.status !== 'started') {
          const feedback = terminal(ack.status)
            ? await this.delegationFeedbackForAck(client, deliveryId, ack.attempt)
            : {};
          return {
            delivery_id: deliveryId,
            status: row.status,
            applied: false,
            receipt: 'duplicate',
            ...feedback,
          };
        }
        // An exact event previously rejected is re-evaluated: a resend may still salvage the
        // result. If it is still invalid it keeps the same receipt; `insertAck` only raises
        // `applied` from false to true. That way the first rejection does not become
        // irrevocable without looking at the content again.
      }
      // A terminal row only admits the exact applied replay resolved above.
      // A new event_id does not mutate or extend the terminal history, nor reconstruct feedback.
      if (row.status === 'done' || row.status === 'failed') {
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'ownership_lost',
        };
      }
      // A foreign identity never fences: it falls through to the salvage and gets the correlated
      // receipt. Ownership is enforced by the lease check and by `lateTerminalSalvage`.
      const exactClaim = row.claim_token === ack.claim_token
        && row.attempt === ack.attempt
        && row.claim_live
        && ['leased', 'accepted', 'started'].includes(row.status);
      if (!exactClaim) {
        // The lease was lost. The RESULT may still be valid: see `lateTerminalSalvage`.
        const salvaged = await this.lateTerminalSalvage(
          client, tenantId, alias, row, ack, persistedResult, outputs, notifications
        );
        if (salvaged) return salvaged;
        if (!repeatedAck) await this.insertAck(client, row, ack, false, persistedResult);
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'ownership_lost',
        };
      }
      const lease = await client.query(
        `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3
         AND epoch=$4 AND lease_until>now()`, [tenantId, alias, ack.instance_id, ack.epoch]
      );
      if (lease.rowCount !== 1
        || row.consumer_instance_id !== ack.instance_id
        || Number(row.consumer_epoch) !== ack.epoch) {
        await this.insertAck(client, row, ack, false, persistedResult);
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'ownership_lost',
        };
      }
      const rank = ackRank(ack.status);
      // Durable point of no return: the SDK waits for this receipt before invoking.
      // A later crash is ambiguous; COALESCE preserves the first commitment of the attempt.
      const executionStarted = ack.status === 'started' && ack.execution_started === true;
      const leaseCapMs = deliveryLeaseCapMs(row.body, leaseCap);
      // Heartbeat of a queued delivery ('accepted'): extends the deadline respecting the
      // leaseCap without altering the state or recording execution start.
      if (ack.status === 'accepted' && row.status === 'accepted') {
        await client.query(
          `UPDATE deliveries
           SET ack_deadline_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(execution_started_at,claimed_at) + $3*interval '1 millisecond'),
               claim_expires_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(execution_started_at,claimed_at) + $3*interval '1 millisecond'),
               updated_at=now()
           WHERE id=$1 AND status='accepted'`,
          [deliveryId, ackDeadlineMs, leaseCapMs]
        );
        if (!repeatedAck) await this.insertAck(client, row, ack, true, persistedResult, true);
        await client.query(
          `INSERT INTO audit_events(
             tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
           ) VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
          [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
            JSON.stringify({
              ack: ack.status,
              resulting_status: row.status,
              epoch: ack.epoch,
              attempt: ack.attempt,
              lease_renewed: true,
              queued: true,
              ...(repeatedAck ? { duplicate_replay: true } : {})
            })]
        );
        return {
          delivery_id: deliveryId,
          status: 'accepted',
          applied: true,
          receipt: repeatedAck ? 'duplicate' : 'applied',
        };
      }
      if (ack.status === 'started' && row.status === 'started') {
        // The anchor uses the post-UPDATE value because PostgreSQL evaluates SET on the old
        // row. It must match the instant the reaper looks at, so the reason does not degrade
        // to ACK timeout. `LEAST` ignores NULL: a row without an anchor has no ceiling.
        await client.query(
          `UPDATE deliveries
           SET ack_deadline_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(CASE WHEN $3::boolean THEN COALESCE(execution_started_at,now())
                               ELSE execution_started_at END, claimed_at)
                   + $4*interval '1 millisecond'),
               claim_expires_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(CASE WHEN $3::boolean THEN COALESCE(execution_started_at,now())
                               ELSE execution_started_at END, claimed_at)
                   + $4*interval '1 millisecond'),
               execution_started_at=CASE WHEN $3::boolean
                 THEN COALESCE(execution_started_at,now()) ELSE execution_started_at END,
               updated_at=now()
           WHERE id=$1`,
          [deliveryId, ackDeadlineMs, executionStarted, leaseCapMs]
        );
        // If a previously rejected event is now applied, `insertAck` raises false to true.
        // For an already-applied duplicate it remains an exact no-op.
        await this.insertAck(client, row, ack, true, persistedResult, true);
        await client.query(
          `INSERT INTO audit_events(
             tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
           ) VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
          [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
            JSON.stringify({
              ack: ack.status,
              resulting_status: row.status,
              epoch: ack.epoch,
              attempt: ack.attempt,
              lease_renewed: true,
              ...(executionStarted ? { execution_started: true } : {}),
              ...(repeatedAck ? { duplicate_replay: true } : {})
            })]
        );
        return {
          delivery_id: deliveryId,
          status: 'started',
          applied: true,
          receipt: repeatedAck ? 'duplicate' : 'applied',
        };
      }
      // `exactClaim` already restricted the row to 'leased', 'accepted' or 'started'.
      if (rank <= row.last_ack_rank) {
        await this.insertAck(client, row, ack, false, persistedResult);
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'superseded',
        };
      }

      let nextStatus: DeliveryState = ack.status;
      let nextRank = rank;
      let terminalAt = rank === 3 ? 'now()' : 'NULL';
      let terminalError = postgresTextSafe(ack.error);
      let terminalErrorCode = postgresTextSafe(ack.error_code);
      // If the failure is ambiguous but execution never started (execution_started_at is null),
      // a retry is allowed if attempts remain; otherwise it goes to dead.
      const ambiguousFailure = ack.status === 'failed'
        && isAmbiguousAckErrorCode(ack.error_code);
      const ambiguousExecution = ambiguousFailure && row.execution_started;
      if (ambiguousExecution) {
        nextStatus = 'dead';
        terminalAt = 'now()';
      } else if (ack.status === 'failed' && (ack.retryable || ambiguousFailure)) {
        if (row.attempt < row.max_attempts) {
          nextStatus = 'retry';
          nextRank = 0;
          terminalAt = 'NULL';
        } else {
          nextStatus = 'dead';
          terminalAt = 'now()';
        }
      }
      if (nextStatus === 'done' && row.body.type === 'agent.fanin') {
        if (outputs.length > 0) {
          nextStatus = 'failed';
          terminalError = 'agent.fanin cannot delegate new messages';
          terminalErrorCode = 'FANIN_REDELEGATION_FORBIDDEN';
        } else if (!textualReply(persistedResult)) {
          nextStatus = 'failed';
          terminalError = 'agent.fanin requires a non-empty final reply';
          terminalErrorCode = 'MISSING_FINAL_REPLY';
        }
      }
      const backoffSeconds = Math.min(60, 2 ** Math.max(0, row.attempt - 1));
      // The FIRST 'started' moves the deadline just like a renewal: gateway and database must
      // date the same lease from the same fact, the applied ACK.
      await client.query(
         `UPDATE deliveries SET status=$2,last_ack_rank=$3,last_error=$4,result=$5::jsonb,
            available_at=CASE WHEN $2='retry' THEN now()+$6*interval '1 second' ELSE available_at END,
             claimed_at=CASE WHEN $2='retry' THEN NULL ELSE claimed_at END,
             claim_expires_at=CASE WHEN $2='retry' THEN NULL
                                   WHEN $2='started' THEN LEAST(
                                     now()+$7*interval '1 millisecond',
                                     COALESCE(CASE WHEN $8::boolean THEN COALESCE(execution_started_at,now())
                                                   ELSE execution_started_at END, claimed_at)
                                       + $9*interval '1 millisecond')
                                   ELSE claim_expires_at END,
             ack_deadline_at=CASE WHEN $2='retry' THEN NULL
                                  WHEN $2='started' THEN LEAST(
                                    now()+$7*interval '1 millisecond',
                                    COALESCE(CASE WHEN $8::boolean THEN COALESCE(execution_started_at,now())
                                                  ELSE execution_started_at END, claimed_at)
                                      + $9*interval '1 millisecond')
                                  ELSE ack_deadline_at END,
             execution_started_at=CASE WHEN $2='retry' THEN NULL
                                       WHEN $8::boolean THEN COALESCE(execution_started_at,now())
                                       ELSE execution_started_at END,
             claim_token=CASE WHEN $2='retry' THEN NULL ELSE claim_token END,
             consumer_instance_id=CASE WHEN $2='retry' THEN NULL ELSE consumer_instance_id END,
            consumer_epoch=CASE WHEN $2='retry' THEN NULL ELSE consumer_epoch END,
            terminal_at=${terminalAt},updated_at=now() WHERE id=$1`,
        [deliveryId, nextStatus, nextRank, terminalError ?? null,
          persistedResult ? JSON.stringify(persistedResult) : null, backoffSeconds,
          ackDeadlineMs, executionStarted, leaseCapMs]
      );
      if (nextStatus === 'done') {
        await this.recordProfileRuntimeAdoption(
          client, tenantId, alias, row, ack, runtimeAdoption,
        );
      }
      if (nextStatus === 'retry') {
        await client.query(
          `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
           VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
           ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
          [tenantId, `wake-retry:${deliveryId}:${String(row.attempt)}`, row.request_id, row.message_id, deliveryId,
            row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
            JSON.stringify({ recipient_alias: alias, reason: 'delivery_available' }), backoffSeconds]
        );
      }
      // Every terminal error leaves a replayable trail in dead_letters, not only 'dead'.
      //
      // Keeping a record in dead_letters lets `replayDelivery` work both for deliveries in state 'failed'
      // and 'dead'. The fix is NOT merging 'failed' with 'dead': both states are consumed today, with
      // distinct meanings, by `terminal()`, the fan-in count (`status IN ('done','failed','dead')`), the
      // CHECK on `deliveries.status`, `DeliveryStateSchema`, the dispatcher's `cauce_dispatcher_delivery_*`
      // series, and four console views. Merging them would erase the only useful distinction left—"the
      // agent declared a definitive error" vs "the system gave up"—and leave a metric series at zero for
      // nothing: what makes a delivery recoverable is having a row in `dead_letters`, not its state. So
      // the row is emitted for BOTH terminal errors and `replayDelivery`'s filter is relaxed; the rest
      // of the system does not notice.
      //
      // `retryable` keeps its only legitimate job: deciding whether the bus RETRIES on its own. It stops
      // deciding whether a human can salvage the delivery.
      if (nextStatus === 'dead' || nextStatus === 'failed') {
        await client.query(
          `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
           SELECT $1,$2,$3,m.body,$4 FROM messages m WHERE m.id=$5
           ON CONFLICT(delivery_id) DO NOTHING`,
          [deliveryId, tenantId,
            terminalError ?? terminalErrorCode
              ?? (nextStatus === 'dead'
                ? 'max attempts exhausted'
                : 'non-retryable failure without error text'),
            row.attempt, row.message_id]
        );
      }
      await this.insertAck(client, row, ack, true, persistedResult);
      let notified = { allowed: 0, denied: 0, errors: 0 };
      let delegationRejections: DelegationRejection[] = [];
      let delegationMaterializations: DelegationMaterialization[] = [];
      let chainGate: OpenChainGate | undefined;
      if (terminal(nextStatus)) {
        const policy = await this.loadChainPolicy(client);
        // Proactive egress is a terminal side effect and does not count as delegation.
        // `ambiguousFailure` vetoes notifications when the result is uncertain even without an
        // execution mark; `ambiguousExecution` would relax the veto once attempts are exhausted
        // and could assert unproven effects.
        notified = await this.materializeAgentNotifications(
          client, row, ack, notifications, ambiguousFailure
        );
        let outputOutcome: AgentOutputOutcome = {
          materialized: 0, suspended: false, rejections: [], materializations: []
        };
        if (nextStatus === 'done' && row.body.type !== 'agent.fanin') {
          outputOutcome = await this.materializeAgentOutputs(client, row, ack, outputs, policy);
        }
        delegationRejections = [...outputOutcome.rejections]
          .sort((left, right) => left.output_index - right.output_index);
        delegationMaterializations = [...outputOutcome.materializations]
          .sort((left, right) => left.output_index - right.output_index);
        chainGate = outputOutcome.gate;
        const materializedOutputs = outputOutcome.materialized;
        // Delegating or suspending does not end the branch from the parent's perspective.
        // Only the authenticated agent.response continuation can return the terminal to the
        // parent. An open human gate keeps the chain pending and cannot be closed with this ACK.
        const responseDisposition: AgentResponseDisposition = materializedOutputs > 0
          || outputOutcome.suspended
          ? 'deferred'
          : await this.materializeAgentResponse(
              client,
              row,
              ack.attempt,
              nextStatus,
              policy,
              persistedResult,
              terminalError,
              terminalErrorCode
            );
        const rootMessageId = this.rootMessageId(row);
        const fanin = await this.materializeAgentFanin(client, rootMessageId);
        if (responseDisposition === 'not_child'
          && (row.body.type === 'agent.fanin' || !fanin.hasFanout)) {
          await this.insertOriginRelay(client, row, nextStatus, {
            ...(persistedResult === undefined ? {} : { result: persistedResult }),
            ...(terminalError === undefined ? {} : { error: terminalError }),
            ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode })
          });
        }
      }
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata)
         VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
        [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
           JSON.stringify({
             ack: ack.status,
             resulting_status: nextStatus,
             epoch: ack.epoch,
             attempt: ack.attempt,
             ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode }),
             ...(ambiguousExecution ? { ambiguous_execution: true } : {}),
              // In audit, distinguishes the ambiguous-executed from the retryable that did not run.
             ...(ambiguousFailure && !row.execution_started
               ? { ambiguous_without_execution: true }
               : {}),
             ...(notified.allowed + notified.denied + notified.errors === 0
               ? {}
               : {
                 notifications_allowed: notified.allowed,
                 notifications_denied: notified.denied,
                 notifications_failed: notified.errors
               })
           })]
      );
      return {
        delivery_id: deliveryId,
        status: nextStatus,
        applied: true,
        receipt: 'applied',
        // Absent when there is nothing to say: adding empty keys would change the bytes the
        // gateway returns to EVERY ACK, and there are older adapters comparing the response.
        ...(delegationRejections.length === 0
          ? {}
          : { delegation_rejections: delegationRejections }),
        ...(delegationMaterializations.length === 0
          ? {}
          : { delegation_materializations: delegationMaterializations }),
        ...(chainGate === undefined
          ? {}
          : { chain_gate: { gate_id: chainGate.id, question: chainGate.question } })
      };
    });
  }


  /**
   * Salvages a terminal result ('done' or 'failed' with text) that arrives after exclusivity
   * has expired, provided the delivery has no prior result and has not been manually canceled.
   */
  private async lateTerminalSalvage(
    client: DatabaseClient,
    tenantId: Tenant,
    alias: string,
    row: DeliveryRow & LateResultRow,
    ack: Ack,
    persistedResult: Record<string, unknown> | undefined,
    outputs: AgentOutputEntry[],
    notifications: AgentNotifyEntry[]
  ): Promise<AckResult | undefined> {
    // S1: only a terminal with a visible reply.
    if (ack.status !== 'done' && ack.status !== 'failed') return undefined;
    const reply = textualReply(persistedResult);
    if (!reply) return undefined;
    // S2: a late salvage cannot materialize delegations.
    if (outputs.length > 0) return undefined;
    // S5: a single terminal; never replaces a prior result.
    if (row.status === 'done' || row.status === 'failed') return undefined;
    if (row.late_result_at !== null) return undefined;
    // Deliveries canceled by an operator are not salvaged, to avoid duplicate replies to the parent.
    if (row.cancelled_at !== null) return undefined;
    // S6: `failed` only corrects an already-declared death.
    if (ack.status === 'failed' && row.status !== 'dead') return undefined;
    // An ACK claiming to belong to an attempt the delivery has not yet reached is not late:
    // it is impossible. It is rejected without looking further.
    if (ack.attempt > row.attempt) return undefined;
    // S4: the authenticated instance keeps a live lease.
    const lease = await client.query(
      `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3
       AND epoch=$4 AND lease_until>now()`, [tenantId, alias, ack.instance_id, ack.epoch]
    );
    if (lease.rowCount !== 1) return undefined;
    // S3: the lease must be recorded in the row or in `delivery_acks`.
    const provenance = await this.lateClaimProvenance(client, row, ack);
    if (provenance === 'none') return undefined;

    const salvagedStatus: DeliveryState = ack.status === 'done' ? 'done' : 'dead';
    const terminalError = postgresTextSafe(ack.error);
    const terminalErrorCode = postgresTextSafe(ack.error_code);
    const previousStatus = row.status;

    // `last_ack_rank=3` leaves the row in terminal range, so a lower-rank ACK arriving later
    // gets 'superseded' and does not come back in here. The deadlines are cleared because
    // there is no longer a live lease for them to describe; `claim_token` and the consumer are
    // KEPT, which is the only trace of who had it at the end.
    await client.query(
      `UPDATE deliveries
       SET status=$2,last_ack_rank=3,last_error=$3,result=$4::jsonb,
           terminal_at=COALESCE(terminal_at,now()),
           late_result_at=now(),late_result_attempt=$5,
           claim_expires_at=NULL,ack_deadline_at=NULL,updated_at=now()
       WHERE id=$1`,
      [row.id, salvagedStatus, terminalError ?? null,
        persistedResult ? JSON.stringify(persistedResult) : null, ack.attempt]
    );

    const relayDisposition = await this.undoDeathNotice(
      client, row, ack, salvagedStatus, previousStatus, persistedResult,
      terminalError, terminalErrorCode
    );

    await this.insertAck(client, row, ack, true, persistedResult);
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'delivery.late_result','allow',$3,$4,$5,$6,$7::jsonb)`,
      [tenantId, alias, row.request_id, row.message_id, row.id, row.trace_id,
        JSON.stringify({
          ack: ack.status,
          resulting_status: salvagedStatus,
          previous_status: previousStatus,
          epoch: ack.epoch,
          attempt: ack.attempt,
          delivery_attempt: row.attempt,
          claim_provenance: provenance,
          reply_characters: reply.length,
          // Audits effects omitted by S2 to measure its false rejections.
          skipped_delegations: outputs.length,
          skipped_notifications: notifications.length,
          origin_relay: relayDisposition,
          ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode })
        })]
    );
    return {
      delivery_id: row.id,
      status: salvagedStatus,
      applied: true,
      // Keeps the `.strict()` contract receipt; salvage is distinguished in audit and
      // deliveries columns, not in a value older adapters would reject.
      receipt: 'applied',
    };
  }


  /**
   * Proves the lease existed: the token is only valid if it was recorded.
   * `current` matches deliveries; `applied` was validated under live ownership.
   * `observed` lives in delivery_acks and is only valid with authenticated recipient plus a
   * live S4 lease. The audit preserves the quality of the proof so it can be hardened to
   * `applied`.
   */
  private async lateClaimProvenance(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack
  ): Promise<LateClaimProvenance> {
    if (row.claim_token === ack.claim_token
      && row.attempt === ack.attempt
      && row.consumer_instance_id === ack.instance_id
      && Number(row.consumer_epoch) === ack.epoch) {
      return 'current';
    }
    const proof = await client.query<{ applied: boolean | null }>(
      `SELECT bool_or(applied) AS applied FROM delivery_acks
       WHERE delivery_id=$1 AND claim_token=$2 AND attempt=$3
         AND instance_id=$4 AND epoch=$5 AND event_id IS DISTINCT FROM $6`,
      [row.id, ack.claim_token, ack.attempt, ack.instance_id, ack.epoch, ack.event_id]
    );
    const applied = proof.rows[0]?.applied ?? null;
    if (applied === null) return 'none';
    return applied ? 'applied' : 'observed';
  }


  /**
   * Reconciles the three effects of a death: delivery, dead-letter, and notice.
   *
   * `done` resolves the dead-letter; `failed` keeps the row with the actual error. The parent receives
   * a fresh corrective response because the previous notice may have been read. A pending human relay
   * is rewritten to emit a single correct message; if it already went out, `relay-late` is created with
   * `LATE_RESULT_HUMAN_NOTICE`. `FOR UPDATE` on the relay serializes the decision against the dispatcher,
   * so a replay of a done is never offered, nor a human correction sent without context.
   */
  private async undoDeathNotice(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    salvagedStatus: DeliveryState,
    previousStatus: DeliveryState,
    persistedResult: Record<string, unknown> | undefined,
    terminalError: string | undefined,
    terminalErrorCode: string | undefined
  ): Promise<LateRelayDisposition> {
    if (salvagedStatus === 'done') {
      await client.query(
        `UPDATE dead_letters SET resolved_at=now()
         WHERE delivery_id=$1 AND resolved_at IS NULL`,
        [row.id]
      );
    } else if (terminalError !== undefined || terminalErrorCode !== undefined) {
      await client.query(
        `UPDATE dead_letters SET reason=$2 WHERE delivery_id=$1 AND resolved_at IS NULL`,
        [row.id, terminalError ?? terminalErrorCode]
      );
    }
    const policy = await this.loadChainPolicy(client);
    const responseDisposition = await this.materializeAgentResponse(
      client, row, ack.attempt, salvagedStatus, policy, persistedResult,
      terminalError, terminalErrorCode, { previousStatus }
    );
    const fanin = await this.materializeAgentFanin(client, this.rootMessageId(row));
    if (responseDisposition !== 'not_child'
      || (row.body.type !== 'agent.fanin' && fanin.hasFanout)) {
      return 'skipped';
    }
    return this.insertOriginRelay(client, row, salvagedStatus, {
      ...(persistedResult === undefined ? {} : { result: persistedResult }),
      ...(terminalError === undefined ? {} : { error: terminalError }),
      ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode })
    }, { previousStatus, attempt: ack.attempt });
  }
}
