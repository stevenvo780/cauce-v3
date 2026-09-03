import { isLiteralTrue, type DeliveryState } from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "error" */
import type { DatabaseClient } from '../../db.js';
import { withTransaction } from '../../db.js';
import { BaseRepository } from '../base.js';
import { StoreError } from '../errors.js';
import type {
  AgentFaninDisposition, AgentResponseDisposition, ChainPolicy, DeliveryRow, LateRelayDisposition
} from './contracts.js';
import {
  deadLetterBodySql, MESSAGE_ATTACHMENT_PRUNE_SQL, resolvedMessageAttachmentRetention,
  type MessageAttachmentRetentionPolicy, type MessageAttachmentRetentionResult
} from './message-body-retention.js';
import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS,
  DEFAULT_RETENTION_AUDIT_RENEWAL_MS, DEFAULT_RETENTION_BATCH, DISPOSABLE_AUDIT_ACTIONS,
  leaseCapInstantSql, leaseCapMsSql, positiveMs, timeoutRetryBackoffSeconds,
  type ObservabilityRetentionPolicy, type ObservabilityRetentionResult, type StaleDeliveryPolicy
} from './policy.js';

export abstract class ObservabilityMaintenanceRepository extends BaseRepository {

  protected abstract loadChainPolicy(client: DatabaseClient): Promise<ChainPolicy>;

  protected abstract materializeAgentResponse(
    client: DatabaseClient,
    row: DeliveryRow,
    attempt: number,
    outcome: DeliveryState,
    policy: ChainPolicy,
    result: Record<string, unknown> | undefined,
    error?: string,
    errorCode?: string,
    late?: { previousStatus: DeliveryState }
  ): Promise<AgentResponseDisposition>;

  protected abstract materializeAgentFanin(
    client: DatabaseClient,
    rootMessageId: string | undefined
  ): Promise<AgentFaninDisposition>;

  protected abstract rootMessageId(row: DeliveryRow): string | undefined;

  protected abstract insertOriginRelay(
    client: DatabaseClient,
    row: DeliveryRow,
    outcome: string,
    ack: {
      result?: Record<string, unknown> | undefined;
      error?: string | undefined;
      error_code?: string | undefined;
    },
    late?: { previousStatus: DeliveryState; attempt: number }
  ): Promise<LateRelayDisposition>;

  async retryStaleDeliveries(
    staleMs: number,
    limit = 100,
    policy: StaleDeliveryPolicy = {}
  ): Promise<{ retried: number; dead: number; parked: number }> {
    const retryStartedDeliveries = policy.retryStartedDeliveries === true;
    const parkWithoutConsumer = policy.parkWithoutConsumer !== false;
    const noConsumerParkMaxAgeMs = positiveMs(
      policy.noConsumerParkMaxAgeMs, DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, 'no-consumer park age'
    );
    if (!Number.isSafeInteger(staleMs) || staleMs < 0) {
      throw new StoreError('conflict', 'stale timeout must be a non-negative integer of milliseconds');
    }
    const defaultCapMs = positiveMs(policy.leaseCapMs, DEFAULT_DELIVERY_LEASE_CAP_MS, 'lease cap');
    const graceMs = positiveMs(
      policy.leaseCapGraceMs, DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, 'lease cap grace'
    );
    return withTransaction(this.pool, async (client) => {
      // Scalar projection without window functions, for compatibility with FOR UPDATE OF d. The ceiling
      // is evaluated TWICE (in the projection and in the WHERE) with the same literal expression on
      // purpose: they are scalars over the row the SELECT already brings under lock, not subqueries and
      // certainly not window functions, so they coexist with `FOR UPDATE OF d`.
      const leaseCapExceeded = `${leaseCapInstantSql(`(${leaseCapMsSql('$3', '$4')})`)} <= now()`;
      const rows = await client.query<DeliveryRow & {
        execution_started: boolean;
        lease_cap_exceeded: boolean;
        lease_cap_ms: string;
        age_ms: string;
      }>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,d.max_attempts,
                d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,d.claim_token,d.ack_deadline_at,
                 m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,m.priority,m.origin,
                 m.auth_session_id,m.auth_channel,
                 (d.execution_started_at IS NOT NULL) AS execution_started,
                 (${leaseCapMsSql('$3', '$4')}) AS lease_cap_ms,
                 (EXTRACT(EPOCH FROM (now()-d.created_at))*1000)::bigint AS age_ms,
                 COALESCE(${leaseCapExceeded},false) AS lease_cap_exceeded
          FROM deliveries d JOIN messages m ON m.id=d.message_id
          WHERE d.status IN ('leased','accepted','started')
            AND (($1=0 OR COALESCE(d.ack_deadline_at,d.claim_expires_at,
                                   d.claimed_at+$1*interval '1 millisecond') <= now())
                 OR ${leaseCapExceeded})
         ORDER BY d.claimed_at FOR UPDATE OF d SKIP LOCKED LIMIT $2`,
        [staleMs, limit, defaultCapMs, graceMs]
      );
      const chainPolicy = await this.loadChainPolicy(client);
      // Who has an adapter connected NOW. It is in a separate query and not as a subquery of the SELECT
      // above, on purpose: that SELECT carries `FOR UPDATE OF d` and is the hot path of the reaper; the
      // presence table has one row per fleet alias, so pulling it whole is cheaper than correlating it
      // row by row.
      const consumidorVivo = new Set<string>();
      if (rows.rows.length > 0) {
        const presentes = await client.query<{ tenant_id: string; alias: string }>(
          'SELECT tenant_id,alias FROM connection_leases WHERE lease_until>now()'
        );
        for (const fila of presentes.rows) consumidorVivo.add(`${fila.tenant_id}\u0000${fila.alias}`);
      }
      let retried = 0;
      let dead = 0;
      let parked = 0;
      for (const row of rows.rows) {
        // The adapter confirmed the harness STARTED: it got the session reservation and was about to
        // invoke it. Only with that flag is it retained; "admitted and waiting for the lock" does not
        // count and is retried as usual.
        const heldForReview = row.execution_started && !retryStartedDeliveries;
        const attemptsExhausted = row.attempt >= row.max_attempts;
        const sinConsumidor = !consumidorVivo.has(
          `${row.recipient_tenant}\u0000${row.recipient_alias}`
        );
        // The ceiling overrides the other two conditions and the emergency lever: a delivery that kept
        // renewing for hours is never retried, whether or not it has the execution flag and whether or
        // not `retryStartedDeliveries` is on.
        const leaseCapExhausted = isLiteralTrue(row.lease_cap_exceeded);
        // R3. Spending all three attempts against an alias with no adapter connected is not retrying: no
        // execution happened. It is parked and the attempt is refunded. All three guards are necessary:
        //  - `!heldForReview`: if it is recorded that it started, retention wins; it is not touched.
        //  - `!leaseCapExhausted`: the ceiling overrides everything else.
        //  - `sinConsumidor`: with a live adapter on the other side the failure IS the destination's,
        //    and the attempts count as usual.
        // The age horizon prevents an immortal delivery: past that time it dies, and now it leaves a
        // trail in `audit_events`.
        const sinConsumidorAparcable = parkWithoutConsumer
          && attemptsExhausted
          && !heldForReview
          && !leaseCapExhausted
          && sinConsumidor
          && Number(row.age_ms) < noConsumerParkMaxAgeMs;
        if (sinConsumidorAparcable) {
          const backoffSeconds = timeoutRetryBackoffSeconds(row.attempt);
          await client.query(
            `UPDATE deliveries SET status='pending',attempt=GREATEST(0,attempt-1),last_ack_rank=0,
              claimed_at=NULL,claim_expires_at=NULL,ack_deadline_at=NULL,claim_token=NULL,
              consumer_instance_id=NULL,consumer_epoch=NULL,execution_started_at=NULL,
              available_at=now()+$2*interval '1 second',
              last_error='ACK timeout: no adapter connected; parked without spending an attempt',
              updated_at=now()
             WHERE id=$1`, [row.id, backoffSeconds]
          );
          await client.query(
            `INSERT INTO audit_events(
               tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
             ) VALUES($1,$2,'delivery.parked_no_consumer','allow',$3,$4,$5,$6,$7::jsonb)`,
            [row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id,
              row.trace_id, JSON.stringify({
                reason: 'no_adapter_connected',
                attempt: row.attempt,
                max_attempts: row.max_attempts,
                attempt_refunded: true,
                age_ms: Number(row.age_ms),
                park_max_age_ms: noConsumerParkMaxAgeMs
              })]
          );
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-parked:${row.id}:${String(row.attempt)}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' }),
              backoffSeconds]
          );
          parked += 1;
          continue;
        }
        if (attemptsExhausted || heldForReview || leaseCapExhausted) {
          // When it started, that is the reason that helps the operator: it tells them the run may have
          // finished and re-enqueuing is expensive. Exhausted-attempts is secondary. The ceiling one goes
          // FIRST and with its own wording: "stopped responding" and "won't stop responding" are opposite
          // diagnoses and confusing them sends the operator looking for an adapter that is down while it is
          // actually perfectly alive.
          const reason = leaseCapExhausted
            ? `Lease cap exhausted: delivery renewed its claim past the ${row.lease_cap_ms} ms`
              + ' total execution ceiling; held for manual replay'
            : heldForReview
              ? 'ACK timeout: execution already started; held for manual replay'
              : 'ACK timeout: max attempts exhausted';
          await client.query(
            `UPDATE deliveries SET status='dead',terminal_at=now(),last_error=$2,updated_at=now()
             WHERE id=$1`, [row.id, reason]
          );
          await client.query(
            `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
             VALUES($1,$2,$5,${deadLetterBodySql('$3::jsonb')},$4)
             ON CONFLICT(delivery_id) DO NOTHING`,
            [row.id, row.recipient_tenant, JSON.stringify(row.body), row.attempt, reason]
          );
          let responseDisposition: AgentResponseDisposition = 'not_child';
          try {
            responseDisposition = await this.materializeAgentResponse(
              client,
              row,
              row.attempt,
              'dead',
              chainPolicy,
              undefined,
              reason
            );
          } catch (error) {
            // Delivery already transitioned to dead above. If materialization fails (e.g., recipient membership
            // issue in cross-tenant case), log and continue. This prevents a single bad delivery from
            // crashing the entire reaper tick, which would block cleanup of all other alias deliveries.
            console.error(JSON.stringify({
              event: 'materialization_failed_in_reaper',
              delivery_id: row.id,
              recipient_alias: row.recipient_alias,
              recipient_tenant: row.recipient_tenant,
              error: error instanceof Error ? error.message : String(error)
            }));
          }
          const fanin = await this.materializeAgentFanin(client, this.rootMessageId(row));
          if (responseDisposition === 'not_child'
            && (row.body.type === 'agent.fanin' || !fanin.hasFanout)) {
            await this.insertOriginRelay(client, row, 'dead', { error: reason });
          }
          // Every terminal ending is audited; the action distinguishes lease ceiling from
          // timeout. That distinction keeps both operational counts.
          const action = leaseCapExhausted ? 'delivery.lease_cap' : 'delivery.ack_timeout';
          await client.query(
            `INSERT INTO audit_events(
               tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
             ) VALUES($1,$2,$8,'deny',$3,$4,$5,$6,$7::jsonb)`,
            [row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id,
              row.trace_id, JSON.stringify({
                reason: leaseCapExhausted
                  ? 'lease_cap_exhausted'
                  : heldForReview ? 'execution_already_started' : 'max_attempts_exhausted',
                attempt: row.attempt,
                max_attempts: row.max_attempts,
                attempts_exhausted: attemptsExhausted,
                held_for_manual_replay: heldForReview || leaseCapExhausted,
                // It used to live only in the ceiling branch and is useful in all three: the
                // only question that matters when reviewing a dead delivery is whether the
                // harness got to run.
                execution_started: row.execution_started,
                // No adapter connected and still dead = it exceeded the parking horizon. It is
                // the signal that the destination has been away for too long.
                no_consumer: sinConsumidor,
                ...(leaseCapExhausted ? { lease_cap_ms: Number(row.lease_cap_ms) } : {})
              }), action]
          );
          // Dying also frees a slot in agents.max_concurrent_deliveries: the delivery leaves
          // ('leased','accepted','started') just as if it had finished normally. The retry
          // branch below already wakes the recipient; this one does not, and without a ceiling
          // it didn't matter because the previous claim had taken the whole queue anyway.
          //
          // With a ceiling it does matter: if every in-flight delivery of an alias dies by
          // timeout, the slot is free, no ACK will arrive (which is why they expired) and the
          // pending queue would sit still until someone publishes a new message. The wake costs
          // one outbox row per DEAD delivery — a rare event, not one per tick — and keeps the
          // invariant even: every exit from the in-flight set wakes the recipient.
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-dead:${row.id}:${String(row.attempt)}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' })]
          );
          dead += 1;
        } else {
          // Only what never started is retried; the backoff avoids overlapping the previous process.
          // The execution_started_at flag belongs to the expired attempt and is cleared before the next one.
          const backoffSeconds = timeoutRetryBackoffSeconds(row.attempt);
          await client.query(
            `UPDATE deliveries SET status='retry',last_ack_rank=0,claimed_at=NULL,claim_expires_at=NULL,
              ack_deadline_at=NULL,claim_token=NULL,consumer_instance_id=NULL,consumer_epoch=NULL,
              execution_started_at=NULL,
              available_at=now()+$2*interval '1 second',last_error='ACK timeout',updated_at=now()
             WHERE id=$1`, [row.id, backoffSeconds]
          );
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-timeout:${row.id}:${String(row.attempt)}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' }),
              backoffSeconds]
          );
          retried += 1;
        }
      }
      return { retried, dead, parked };
    });
  }

  /**
   * Four independent DELETEs keep their windows and locks separate.
   * Each DELETE uses `id IN (SELECT ... LIMIT n)` to bound the batch over a live base.
   */
  async pruneObservability(
    policy: ObservabilityRetentionPolicy = {}
  ): Promise<ObservabilityRetentionResult> {
    const ackRenewalMs = positiveMs(
      policy.ackRenewalMs, DEFAULT_RETENTION_ACK_RENEWAL_MS, 'ack renewal retention'
    );
    const ackMs = positiveMs(policy.ackMs, DEFAULT_RETENTION_ACK_MS, 'ack retention');
    const auditRenewalMs = positiveMs(
      policy.auditRenewalMs, DEFAULT_RETENTION_AUDIT_RENEWAL_MS, 'audit renewal retention'
    );
    const auditMs = positiveMs(policy.auditMs, DEFAULT_RETENTION_AUDIT_MS, 'audit retention');
    const batch = positiveMs(policy.batch, DEFAULT_RETENTION_BATCH, 'retention batch');
    const disposable = [...(policy.disposableAuditActions ?? DISPOSABLE_AUDIT_ACTIONS)];
    // A renewal window LONGER than the general one would not delete more than necessary, but
    // it would make the sweep incomprehensible when reading the numbers: the general rule would
    // have already taken the renewals first. Fail here, where it is configured.
    if (ackRenewalMs > ackMs || auditRenewalMs > auditMs) {
      throw new StoreError(
        'conflict', 'renewal retention window cannot exceed the general retention window'
      );
    }
    const prune = async (sql: string, parameters: unknown[]): Promise<number> =>
      (await this.pool.query(sql, parameters)).rowCount ?? 0;
    return {
      ack_renewals: await prune(
        `DELETE FROM delivery_acks WHERE id IN (
           SELECT id FROM delivery_acks
            WHERE renewal AND created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [ackRenewalMs, batch]
      ),
      acks: await prune(
        `DELETE FROM delivery_acks WHERE id IN (
           SELECT id FROM delivery_acks
            WHERE created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [ackMs, batch]
      ),
      // Only allowlisted actions may prune audit renewals. lease_renewed identifies the
      // historical backlog without a column or backfill.
      audit_renewals: disposable.length === 0 ? 0 : await prune(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events
            WHERE action=ANY($3::text[]) AND metadata->>'lease_renewed'='true'
              AND created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [auditRenewalMs, batch, disposable]
      ),
      // ALLOWLIST of actions. See `DISPOSABLE_AUDIT_ACTIONS`: deleting `audit_events` simply
      // by age breaks the replay idempotency lock and the trust mark of the agent-to-agent
      // chain, silently and with weeks of delay.
      audit_events: disposable.length === 0 ? 0 : await prune(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events
            WHERE action=ANY($3::text[])
              AND created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [auditMs, batch, disposable]
      )
    };
  }

  async pruneMessageAttachments(
    policy: MessageAttachmentRetentionPolicy
  ): Promise<MessageAttachmentRetentionResult> {
    const { retentionMs, batch } = resolvedMessageAttachmentRetention(policy);
    const swept = await this.pool.query(MESSAGE_ATTACHMENT_PRUNE_SQL, [retentionMs, batch]);
    return { message_attachments: swept.rowCount ?? 0 };
  }

}
