import { randomUUID } from 'node:crypto';
import type { Ack, NotifyRequest, Origin, Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withTransaction } from '../../db.js';
import { hashToUuidV7 } from '../_hash-to-uuidv7.js';
import type { EgressDestinationRow } from '../egress-destinations.js';
import { AgentChainControlRepository } from './chain-control.js';
import { sha256 } from '../config.js';
import {
  handlePattern, maxNotifyBodyBytes, notifyKinds,
  type AgentNotifyEntry, type NotifyDenialCode
} from '../deliveries.js';
import { StoreError } from '../errors.js';
import { insertMessage } from '../messages/_insert.js';
import type { DeliveryRow } from '../observability.js';
import { visibleText } from '../outbox.js';


/** Carries a dry-run verdict out of a transaction that must be rolled back. */
class NotificationPreview extends Error {
  constructor(readonly verdict: NotificationVerdict) {
    super('proactive egress preview rollback');
    this.name = 'NotificationPreview';
  }
}


export interface NotificationVerdict {
  notification_id: string;
  decision: 'allowed' | 'denied';
  denial_code?: NotifyDenialCode;
  message_id?: string;
  outbox_id?: string;
  duplicate: boolean;
  dry_run: boolean;
}


interface NotificationRequest extends AgentNotifyEntry {
  idempotencyKey: string;
}

interface NotificationContext {
  tenant: Tenant;
  alias: string;
  source: 'agent_output' | 'http' | 'job';
  requestId: string;
  traceId: string;
  sourceDeliveryId?: string;
  sourceAttempt?: number;
  sourceMessageId?: string;
  sourceRootMessageId?: string;
}

/**
 * messages_request_actor_idx is UNIQUE(tenant_id, actor_alias, request_id), so a
 * derived request_id keeps a re-ACK of the same attempt from ever producing a
 * second notification message even if the first idempotency layer were bypassed.
 */
function agentNotifyRequestId(deliveryId: string, attempt: number, notifyIndex: number): string {
  return hashToUuidV7(`agent-notify:${deliveryId}:${attempt}:${notifyIndex}`);
}

export abstract class AgentNotificationsRepository extends AgentChainControlRepository {

  /**
   * The single authorization engine for proactive egress. Both surfaces (the
   * in-band `notify[]` of an agent ACK and POST /v3/egress/notifications) go
   * through here, so there is exactly one place where the answer to "may this
   * alias write to this human right now" is decided.
   *
   * Every step is default-deny and every refusal becomes a durable
   * `egress_notifications` row plus an audit event. It never throws for a policy
   * decision: a disabled destination must not be able to abort the ACK of a real
   * delivery.
   */
  private async authorizeAndEmitNotification(
    client: DatabaseClient,
    context: NotificationContext,
    request: NotificationRequest
  ): Promise<NotificationVerdict> {
    const bodyBytes = Buffer.byteLength(request.body, 'utf8');
    const bodyHash = sha256(request.body);
    const deny = async (code: NotifyDenialCode): Promise<NotificationVerdict> => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO egress_notifications(
           tenant_id,alias,handle,adapter,kind,source,idempotency_key,decision,denial_code,
           body_hash,body_bytes,source_delivery_id,source_attempt,notify_index,
           source_message_id,source_root_message_id,request_id,trace_id,correlation
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'denied',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
         RETURNING id`,
        [
          context.tenant, context.alias, request.handle, 'telegram', request.kind, context.source,
          request.idempotencyKey, code, bodyHash, bodyBytes,
          context.sourceDeliveryId ?? null, context.sourceAttempt ?? null,
          context.source === 'agent_output' ? request.index : null,
          context.sourceMessageId ?? null, context.sourceRootMessageId ?? null,
          context.requestId, context.traceId,
          JSON.stringify({ source: context.source, notify_index: request.index })
        ]
      );
      const notificationId = inserted.rows[0]!.id;
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,trace_id,metadata)
         VALUES($1,$2,'egress.notify','deny',$3,$4,$5::jsonb)`,
        [context.tenant, context.alias, context.requestId, context.traceId,
          JSON.stringify({
            notification_id: notificationId, handle: request.handle, kind: request.kind,
            denial_code: code, source: context.source, body_bytes: bodyBytes
          })]
      );
      return { notification_id: notificationId, decision: 'denied', denial_code: code, duplicate: false, dry_run: false };
    };

    // 1. Serialize on the idempotency key first, then on the destination. Both
    //    keys are taken in a fixed order and callers iterate handles sorted, so
    //    concurrent notifications cannot build a lock cycle.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`egress-notify:${context.tenant}:${context.alias}:${request.idempotencyKey}`]);
    const replay = await client.query<{
      id: string; decision: 'allowed' | 'denied'; denial_code: NotifyDenialCode | null;
      produced_message_id: string | null; produced_outbox_id: string | null;
    }>(
      `SELECT id,decision,denial_code,produced_message_id,produced_outbox_id
       FROM egress_notifications WHERE tenant_id=$1 AND alias=$2 AND idempotency_key=$3`,
      [context.tenant, context.alias, request.idempotencyKey]
    );
    const previous = replay.rows[0];
    if (previous) {
      return {
        notification_id: previous.id,
        decision: previous.decision,
        ...(previous.denial_code === null ? {} : { denial_code: previous.denial_code }),
        ...(previous.produced_message_id === null ? {} : { message_id: previous.produced_message_id }),
        ...(previous.produced_outbox_id === null ? {} : { outbox_id: previous.produced_outbox_id }),
        duplicate: true,
        dry_run: false
      };
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`egress-notify-destination:${context.tenant}:${context.alias}:${request.handle}`]);

    if (request.forcedDenial) return deny(request.forcedDenial);

    // 2. Role gate and source room in one query. An alias with no enabled
    //    membership carrying allow_notify has no way to emit anything, and the
    //    room it is a member of is the room the notification message lives in.
    const permitted = await client.query<{ room_id: string }>(
      `SELECT membership.room_id
       FROM memberships membership
       JOIN role_policies policy ON policy.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND policy.allow_notify
       ORDER BY membership.room_id LIMIT 1`,
      [context.tenant, context.alias]
    );
    const sourceRoomId = permitted.rows[0]?.room_id;
    if (!sourceRoomId) return deny('notify_permission_denied');

    // 3. The allowlist. Zero rows means default-deny, which is the state the
    //    migration leaves the system in.
    const destinations = await client.query<EgressDestinationRow>(
      `SELECT adapter,channel,conversation_id,conversation_kind,display_label,allow_kinds,require_prior_contact,
              contact_ttl_days,min_interval_seconds,max_per_hour,max_per_day,max_per_root,
              quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled
       FROM egress_destinations WHERE tenant_id=$1 AND alias=$2 AND handle=$3 FOR SHARE`,
      [context.tenant, context.alias, request.handle]
    );
    const destination = destinations.rows[0];
    if (!destination) return deny('unknown_destination');
    if (!destination.enabled) return deny('destination_disabled');
    if (!destination.allow_kinds.includes(request.kind)) return deny('kind_not_allowed');

    // 4. No cold contact. A destination that requires prior contact needs a real
    //    authenticated inbound message from that conversation to this alias,
    //    inside the configured freshness window.
    if (destination.require_prior_contact) {
      const contact = await client.query(
        `SELECT 1 FROM egress_contacts
         WHERE tenant_id=$1 AND alias=$2 AND adapter=$3 AND conversation_id=$4
           AND inbound_count>=1
           AND last_inbound_at > clock_timestamp() - ($5::int * interval '1 day')`,
        [context.tenant, context.alias, destination.adapter, destination.conversation_id,
          destination.contact_ttl_days]
      );
      if (contact.rowCount !== 1) return deny('cold_contact');
    }

    // 5. Sliding windows, computed with clock_timestamp() so a long transaction
    //    cannot back-date its own notification out of the window.
    const windows = await client.query<{ last_hour: string; last_day: string; last_at: Date | null }>(
      `SELECT count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 hour') AS last_hour,
              count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 day') AS last_day,
              max(created_at) AS last_at
       FROM egress_notifications
       WHERE tenant_id=$1 AND alias=$2 AND handle=$3 AND decision='allowed'`,
      [context.tenant, context.alias, request.handle]
    );
    const usage = windows.rows[0];
    if (usage) {
      if (Number(usage.last_hour) >= destination.max_per_hour) return deny('rate_limited');
      if (Number(usage.last_day) >= destination.max_per_day) return deny('rate_limited');
      if (usage.last_at !== null && destination.min_interval_seconds > 0) {
        const elapsedMs = Date.now() - usage.last_at.getTime();
        if (elapsedMs < destination.min_interval_seconds * 1_000) return deny('rate_limited');
      }
    }

    // 6. Per-chain quota. The chain is source_root_message_id; root_message_id is
    //    the notification's own message id and is unique per row, so counting on
    //    it would silently disable this limit.
    if (context.sourceRootMessageId !== undefined) {
      const chain = await client.query<{ used: string }>(
        `SELECT count(*) AS used FROM egress_notifications
         WHERE decision='allowed' AND source_root_message_id=$1`,
        [context.sourceRootMessageId]
      );
      if (Number(chain.rows[0]?.used ?? 0) >= destination.max_per_root) return deny('root_quota_exhausted');
    }

    // 7. Quiet hours. An unknown timezone falls back to UTC instead of raising,
    //    because raising here would abort the ACK transaction.
    if (destination.quiet_hours_start !== null && destination.quiet_hours_end !== null
      && destination.quiet_hours_start !== destination.quiet_hours_end) {
      const local = await client.query<{ hour: number }>(
        `SELECT extract(hour FROM clock_timestamp() AT TIME ZONE coalesce(
           (SELECT name FROM pg_timezone_names WHERE name=$1 LIMIT 1),'UTC'
         ))::int AS hour`,
        [destination.quiet_hours_tz]
      );
      const hour = local.rows[0]?.hour ?? 0;
      const start = destination.quiet_hours_start;
      const end = destination.quiet_hours_end;
      const quiet = start < end ? hour >= start && hour < end : hour >= start || hour < end;
      if (quiet) return deny('quiet_hours');
    }

    const notificationMessage = await insertMessage(client, {
      requestId: context.requestId,
      traceId: context.traceId,
      tenantId: context.tenant,
      roomId: sourceRoomId,
      actorAlias: context.alias,
      body: {
          type: 'agent.notify',
          text: request.body,
          notify_kind: request.kind,
          destination_handle: request.handle,
          from_alias: context.alias,
          correlation: {
            source: context.source,
            ...(context.sourceDeliveryId === undefined ? {} : { source_delivery_id: context.sourceDeliveryId }),
            ...(context.sourceMessageId === undefined ? {} : { source_message_id: context.sourceMessageId }),
            ...(context.sourceRootMessageId === undefined
              ? {}
              : { source_root_message_id: context.sourceRootMessageId }),
            trace_id: context.traceId
          }
      },
      origin: this.notificationOrigin(context, destination),
      lane: 'interactive',
      priority: 0,
      authSessionId: `egress-notify:${context.tenant}:${context.alias}:${request.idempotencyKey}`,
      authChannel: destination.channel,
    });
    const notificationMessageId = notificationMessage.rows[0]!.id;

    // The relay's own correlation root is the notification message itself, never
    // the chain it came from. Reusing the inbound root would make claimOutbox's
    // supersession CTE kill the pending 'Recibido' acknowledgement of that
    // conversation. The originating chain travels in source_correlation.
    const relayPayload = {
      relay_kind: 'notify',
      terminal: true,
      outcome: 'done',
      kind: request.kind,
      result: {
        output: {
          reply: request.body,
          messages: [],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      },
      correlation: {
        request_id: context.requestId,
        message_id: notificationMessageId,
        trace_id: context.traceId,
        root_message_id: notificationMessageId
      },
      source_correlation: {
        source: context.source,
        ...(context.sourceDeliveryId === undefined ? {} : { source_delivery_id: context.sourceDeliveryId }),
        ...(context.sourceMessageId === undefined ? {} : { source_message_id: context.sourceMessageId }),
        ...(context.sourceRootMessageId === undefined
          ? {}
          : { source_root_message_id: context.sourceRootMessageId }),
        ...(context.sourceAttempt === undefined ? {} : { source_attempt: context.sourceAttempt })
      }
    };
    // No ON CONFLICT clause: the idempotency key carries a fresh notification id,
    // so a conflict is impossible, and swallowing one would leave
    // produced_outbox_id NULL and abort the whole transaction on the CHECK.
    const notificationId = randomUUID();
    const outbox = await client.query<{ id: string }>(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,origin,payload
       ) VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING id`,
      [
        context.tenant, destination.adapter, `notify:${notificationId}`, context.requestId,
        notificationMessageId, context.traceId,
        JSON.stringify(this.notificationOrigin(context, destination)),
        JSON.stringify(relayPayload)
      ]
    );
    const outboxId = outbox.rows[0]!.id;
    const stored = await client.query<{ id: string }>(
      `INSERT INTO egress_notifications(
         id,tenant_id,alias,handle,adapter,conversation_id,kind,source,idempotency_key,decision,
         body_hash,body_bytes,source_delivery_id,source_attempt,notify_index,
         source_message_id,source_root_message_id,produced_message_id,produced_outbox_id,
         root_message_id,request_id,trace_id,correlation
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'allowed',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb)
       RETURNING id`,
      [
        notificationId, context.tenant, context.alias, request.handle, destination.adapter,
        destination.conversation_id, request.kind, context.source, request.idempotencyKey,
        bodyHash, bodyBytes,
        context.sourceDeliveryId ?? null, context.sourceAttempt ?? null,
        context.source === 'agent_output' ? request.index : null,
        context.sourceMessageId ?? null, context.sourceRootMessageId ?? null,
        notificationMessageId, outboxId, notificationMessageId,
        context.requestId, context.traceId,
        JSON.stringify({ source: context.source, notify_index: request.index })
      ]
    );
    await client.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,trace_id,metadata)
       VALUES($1,$2,'egress.notify','allow',$3,$4,$5,$6::jsonb)`,
      [context.tenant, context.alias, context.requestId, notificationMessageId, context.traceId,
        JSON.stringify({
          notification_id: notificationId, handle: request.handle, kind: request.kind,
          source: context.source, adapter: destination.adapter, body_bytes: bodyBytes
        })]
    );
    return {
      notification_id: stored.rows[0]!.id,
      decision: 'allowed',
      message_id: notificationMessageId,
      outbox_id: outboxId,
      duplicate: false,
      dry_run: false
    };
  }

  /**
   * Synthetic return route. It carries no external_message_id on purpose: a
   * proactive relay does not answer an inbound message, so the bridge must not
   * try to place a reaction on some arbitrary message id of that chat.
   */
  private notificationOrigin(
    context: NotificationContext,
    destination: EgressDestinationRow
  ): Origin {
    return {
      adapter: destination.adapter,
      channel: destination.channel,
      conversation_id: destination.conversation_id,
      relay: [],
      metadata: {
        bridge_alias: context.alias,
        bridge_tenant: context.tenant,
        chat_type: destination.conversation_kind,
        proactive: true
      }
    };
  }

  /**
   * In-band proactive egress from an agent ACK. Runs inside the ACK transaction
   * so either the delivery finished and the notification exists, or neither did.
   *
   * Two invariants make this safe to call on the hot path:
   *  - it returns a count that the caller must NOT feed into the delegation
   *    disposition; a notification is a side effect, never a child of the
   *    delegation tree, and counting it would leave the parent waiting forever.
   *  - each entry is fenced by a SAVEPOINT, so no unexpected database error from
   *    the notification path can abort the ACK of a real delivery.
   */
  protected override async materializeAgentNotifications(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    entries: AgentNotifyEntry[],
    ambiguousExecution: boolean
  ): Promise<{ allowed: number; denied: number; errors: number }> {
    const result = { allowed: 0, denied: 0, errors: 0 };
    if (entries.length === 0) return result;
    const ordered = [...entries].sort((left, right) =>
      left.handle === right.handle ? left.index - right.index : left.handle.localeCompare(right.handle));
    for (const entry of ordered) {
      const context: NotificationContext = {
        tenant: row.recipient_tenant,
        alias: row.recipient_alias,
        source: 'agent_output',
        requestId: agentNotifyRequestId(row.id, ack.attempt, entry.index),
        traceId: row.trace_id,
        sourceDeliveryId: row.id,
        sourceAttempt: ack.attempt,
        sourceMessageId: row.message_id,
        ...(this.rootMessageId(row) === undefined ? {} : { sourceRootMessageId: this.rootMessageId(row)! })
      };
      const request: NotificationRequest = {
        ...entry,
        // An ambiguous execution is a state where the system does not know
        // whether the work happened. It must never become a message to a human
        // claiming it did.
        ...(ambiguousExecution ? { forcedDenial: 'ambiguous_execution' as const } : {}),
        idempotencyKey: `agent:${row.id}:${ack.attempt}:${entry.index}`
      };
      await client.query('SAVEPOINT cauce_notify');
      try {
        const verdict = await this.authorizeAndEmitNotification(client, context, request);
        await client.query('RELEASE SAVEPOINT cauce_notify');
        if (verdict.duplicate) continue;
        if (verdict.decision === 'allowed') result.allowed += 1;
        else result.denied += 1;
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT cauce_notify');
        await client.query('RELEASE SAVEPOINT cauce_notify');
        result.errors += 1;
      }
    }
    return result;
  }

  /**
   * Out-of-band proactive egress for crons, jobs and the console. It shares the
   * whole authorization engine with the in-band path; only the idempotency key
   * namespace and the correlation differ.
   */
  async enqueueNotification(
    actorTenant: Tenant,
    actorAlias: string,
    input: NotifyRequest,
    source: 'http' | 'job' = 'http'
  ): Promise<NotificationVerdict> {
    if (!handlePattern.test(input.destination)) {
      throw new StoreError('not_found', 'notification destination handle is invalid');
    }
    if (!notifyKinds.has(input.kind)) throw new StoreError('conflict', 'notification kind is invalid');
    const bodyDenial = Buffer.byteLength(input.body, 'utf8') > maxNotifyBodyBytes
      ? 'body_too_large' as const
      : visibleText(input.body).length === 0 ? 'invalid_output' as const : undefined;
    const context: NotificationContext = {
      tenant: actorTenant,
      alias: actorAlias,
      source,
      requestId: randomUUID(),
      traceId: `trace-${randomUUID()}`
    };
    const request: NotificationRequest = {
      index: 0,
      handle: input.destination,
      kind: input.kind,
      body: bodyDenial === undefined ? input.body : '',
      ...(bodyDenial === undefined ? {} : { forcedDenial: bodyDenial }),
      idempotencyKey: `${source}:${input.idempotency_key}`
    };
    try {
      return await withTransaction(this.pool, async (client) => {
        const verdict = await this.authorizeAndEmitNotification(client, context, request);
        // A preview must be able to prove a destination works without writing to
        // a human. Same rollback contract as the configuration dry run.
        if (input.dry_run) throw new NotificationPreview({ ...verdict, dry_run: true });
        return verdict;
      });
    } catch (error) {
      if (error instanceof NotificationPreview) return error.verdict;
      throw error;
    }
  }

  /**
   * Denied notifications have no produced message and no outbox row, so the
   * visibility filter of listOriginRelays (which joins messages through the
   * outbox) would discard exactly the rows an operator needs to see. Visibility
   * is derived from the emitting (tenant, alias) against memberships instead.
   */
  async listNotifications(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT notification.id,notification.tenant_id,notification.alias,notification.handle,
              notification.adapter,notification.conversation_id,notification.kind,notification.source,
              notification.decision,notification.denial_code,notification.body_bytes,
              notification.source_delivery_id,notification.source_root_message_id,
              notification.produced_message_id,notification.produced_outbox_id,
              notification.request_id,notification.trace_id,notification.created_at,
              outbox.status AS relay_status,outbox.attempts AS relay_attempts,outbox.sent_at AS relay_sent_at
       FROM egress_notifications notification
       LEFT JOIN adapter_outbox outbox ON outbox.id=notification.produced_outbox_id
       WHERE notification.tenant_id=$1 AND (
         notification.alias=$2
         OR EXISTS (
           SELECT 1 FROM memberships viewer
           JOIN memberships emitter ON emitter.tenant_id=viewer.tenant_id AND emitter.room_id=viewer.room_id
           WHERE viewer.tenant_id=$1 AND viewer.alias=$2 AND viewer.enabled
             AND emitter.alias=notification.alias AND emitter.enabled
         )
       ) ORDER BY notification.created_at DESC LIMIT $3`,
      [actorTenant, actorAlias, limit]
    );
    return { items: result.rows };
  }
}
