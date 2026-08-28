import type { Ack, Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withTransaction } from '../../db.js';
import { AgentNotificationsRepository } from '../agents/notifications.js';
import { postgresTextSafe } from '../deliveries.js';
import { StoreError } from '../errors.js';
import { terminal } from '../messages.js';
import type { DeliveryRow } from '../observability.js';
import { visibleText } from '../outbox.js';


/** Stable prefix of a cancellation reason: what allows counting them without heuristics. */
const cancellationReasonPrefix = 'Cancelled by operator';
const maxCancellationReasonBytes = 500;
/**
 * Reason a cancelled delivery is marked with.
 *
 * The prefix is fixed and the operator's note follows, trimmed. Two reasons: a human reads
 * `last_error` and `dead_letters.reason` in the console, and free-form text without a ceiling
 * can come from a client. NUL is removed because PostgreSQL does not accept it in `text` and
 * the `INSERT` would abort the entire cancellation transaction.
 */
function cancellationReason(actorTenant: Tenant, actorAlias: string, reason?: string): string {
  const header = `${cancellationReasonPrefix} ${actorTenant}:${actorAlias}`;
  const note = visibleText(postgresTextSafe(reason));
  if (!note) return header;
  const trimmed = note.length > maxCancellationReasonBytes
    ? `${note.slice(0, maxCancellationReasonBytes)}…`
    : note;
  return `${header}: ${trimmed}`;
}

export abstract class DeliveryControlRepository extends AgentNotificationsRepository {
  /**
   * CANCELLATION of an in-flight delivery. An operator operation, sibling of `replayDelivery` with
   * exactly its same authorization.
   *
   * IT DOES NOT INVENT A NEW STATE. It ends in 'dead', same as the reaper (see its comment): all the
   * manual-review machinery already points there, and adding 'cancelled' would force widening every check
   * just to reimplement the same replay button. What IS its own is the trail: a reason with a stable prefix
   * and an `audit_events` entry with action `delivery.cancel`, so cancellations can be counted without confusion.
   *
   * IT SENDS NO FRAME TO THE ADAPTER, on purpose. The server side stays consistent in a single transaction;
   * any harness still running will die on its own path (lifetime ceiling) and its late ACK will bounce as
   * `ownership_lost`, because `ackDelivery` cuts first with `terminal(row.status)`. This is the correct
   * degradation: it does not depend on the adapter being alive, exactly the situation that requires cancellation.
   */
  async cancelDelivery(
    deliveryId: string,
    actorTenant: Tenant,
    actorAlias: string,
    reason?: string
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'control');
    const cancelReason = cancellationReason(actorTenant, actorAlias, reason);
    return withTransaction(this.pool, async (client) => {
      // The SAME columns the reaper builds are pulled because the same three helpers
      // (`materializeAgentResponse`, `materializeAgentFanin`, `insertOriginRelay`) are called below,
      // and all of them expect a full `DeliveryRow`. `FOR UPDATE OF d` without a window function:
      // PostgreSQL rejects that combination at parse time (see `sql-locking-clauses.test.ts`).
      const selected = await client.query<DeliveryRow>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,
                d.max_attempts,d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,
                d.claim_token,d.ack_deadline_at,
                m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,
                m.priority,m.origin,m.auth_session_id,m.auth_channel
         FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.id=$1
         FOR UPDATE OF d`,
        [deliveryId]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'delivery not found or not visible');
      await this.assertReplayAuthorization(client, actorTenant, actorAlias, row);
      // A delivery already in a terminal state is not cancelled: it is replayed or left alone.
      // Returning `conflict` instead of "ok" is the honest move, because a second cancel that
      // said yes would make the operator believe they interrupted something that had actually
      // already finished (and maybe finished WELL).
      if (terminal(row.status)) {
        throw new StoreError('conflict', `delivery is already terminal (${row.status})`);
      }

      // Fence fields are cleared in addition to the status. Not cosmetic: as long as
      // `claim_token`/`consumer_epoch` remain set, an adapter still holding the claw can keep
      // renewing it, and the point of cancelling is to release the alias's slot right away.
      const cancelled = await client.query(
        `UPDATE deliveries
           SET status='dead',terminal_at=now(),last_error=$2,last_ack_rank=3,
               cancelled_at=now(),
               claim_expires_at=NULL,ack_deadline_at=NULL,claim_token=NULL,
               consumer_instance_id=NULL,consumer_epoch=NULL,updated_at=now()
         WHERE id=$1 AND status NOT IN ('done','failed','dead')`,
        [row.id, cancelReason]
      );
      if (cancelled.rowCount !== 1) {
        throw new StoreError('conflict', 'delivery became terminal while being cancelled');
      }

      // (1) Replayable trail. The `ON CONFLICT` covers the delivery that already had a dead
      // letter from a previous life; `resolved_at` is set by `replayDelivery` when someone
      // rescues it.
      await client.query(
        `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
         VALUES($1,$2,$5,$3::jsonb,$4)
         ON CONFLICT(delivery_id) DO NOTHING`,
        [row.id, row.recipient_tenant, JSON.stringify(row.body), row.attempt, cancelReason]
      );

      // (2) and (3): the parent and the human, through the same two paths the reaper uses.
      // Unlike the reaper, the materialization error is NOT caught here: the reaper processes a
      // batch and cannot let a single row kill the whole tick, but this is an interactive
      // command on a single delivery. If the parent notice cannot be written, the entire
      // transaction is rolled back and the operator sees the reason, instead of being left with
      // a half-finished cancellation — which is exactly the state the manual UPDATE produces.
      const chainPolicy = await this.loadChainPolicy(client);
      const responseDisposition = await this.materializeAgentResponse(
        client, row, row.attempt, 'dead', chainPolicy, undefined, cancelReason, 'DELIVERY_CANCELLED'
      );
      const fanin = await this.materializeAgentFanin(client, this.rootMessageId(row));
      const relayed = responseDisposition === 'not_child'
        && (row.body.type === 'agent.fanin' || !fanin.hasFanout);
      if (relayed) {
        await this.insertOriginRelay(
          client, row, 'dead', { error: cancelReason, error_code: 'DELIVERY_CANCELLED' }
        );
      }

      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'delivery.cancel','allow',$3,$4,$5,$6,$7::jsonb)`,
        [actorTenant, actorAlias, row.request_id, row.message_id, row.id, row.trace_id,
          JSON.stringify({
            cancelled_from_status: row.status,
            attempt: row.attempt,
            reason: cancelReason,
            recipient_tenant: row.recipient_tenant,
            recipient_alias: row.recipient_alias,
            parent_notice: responseDisposition,
            origin_relayed: relayed
          })]
      );
      return {
        delivery_id: row.id,
        state: 'dead',
        cancelled: true,
        cancelled_from_state: row.status,
        reason: cancelReason,
        parent_notice: responseDisposition,
        origin_relayed: relayed,
        // The operator needs to know this is NOT irreversible: the `dead_letters` row that
        // was just written is what enables the replay button.
        replayable: true
      };
    });
  }

  /**
   * `renewal` separates the heartbeat from the state transition, and that distinction is what makes
   * type-based retention possible: an ACK that only says "I'm still alive" has no forensic value after a
   * few hours, and accounts for ~90% of the table's volume. One that says "I moved from accepted to started"
   * or "I'm done" does have it and is kept much longer. It is flagged here, in the only place that knows for
   * sure which is which (the renewal branch of `ackDelivery`), instead of being inferred afterwards with a
   * window function over the whole table.
   *
   * `DO UPDATE ... WHERE` instead of `DO NOTHING`: the same event may be rejected first and accepted later
   * (a terminal ACK resent that lands in the late rescue the second time around, or one that failed by lease
   * and is retried with the lease already renewed). The row must remain honest. The clause only allows
   * going from `false` to `true`, never the other way, and when the ACK is rejected again the UPDATE is
   * not executed: identical to the old `DO NOTHING`.
   */
  protected override async insertAck(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    applied: boolean,
    persistedResult: Record<string, unknown> | undefined,
    renewal = false
  ): Promise<void> {
    await client.query(
      `INSERT INTO delivery_acks(event_id,delivery_id,status,instance_id,epoch,claim_token,attempt,applied,renewal,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$10,$9::jsonb)
       ON CONFLICT(event_id) DO UPDATE
         SET applied=true,renewal=EXCLUDED.renewal,payload=EXCLUDED.payload
         WHERE delivery_acks.applied=false AND EXCLUDED.applied`,
      [ack.event_id, row.id, ack.status, ack.instance_id, ack.epoch, ack.claim_token, ack.attempt, applied,
        JSON.stringify({
          retryable: ack.retryable,
          ...(postgresTextSafe(ack.error) === undefined
            ? {}
            : { error: postgresTextSafe(ack.error) }),
          ...(postgresTextSafe(ack.error_code) === undefined
            ? {}
            : { error_code: postgresTextSafe(ack.error_code) }),
          ...(persistedResult === undefined ? {} : { result: persistedResult })
        }), renewal]
    );
  }
}
