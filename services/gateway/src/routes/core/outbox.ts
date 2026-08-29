import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import {
  StoreError, subscribeDeliveryWakes, type ConnectionSessionFence,
  type FencedWakeOutboxRecipient, type WakeOutboxClaimFence,
} from '@cauce/store';
import type { GatewayRepository, OutboxLeaseEvent } from '../../app.js';
import type { CoreResolvedOptions, CoreRouteOptions, Session } from './contracts.js';
import { send, sessionFence, sessionKey } from './helpers.js';

/** `Promise.allSettled`, but with a fixed number of workers and one result per entry. */
async function allSettledBounded<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<Array<PromiseSettledResult<void>>> {
  const results = new Array<PromiseSettledResult<void>>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        await operation(values[index]!);
        results[index] = { status: 'fulfilled', value: undefined };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.allSettled(workers);
  return results;
}

export function createCoreOutboxRuntime(
  app: FastifyInstance,
  options: CoreRouteOptions,
  repository: GatewayRepository,
  resolved: CoreResolvedOptions,
  sessions: Map<string, Session>,
  pendingDrains: Set<Promise<boolean>>,
  pendingSessionTasks: Set<Promise<unknown>>,
  drain: (session: Session) => Promise<boolean>,
): { pumpOutbox: () => Promise<void>; start: () => Promise<void> } {
  const {
    outboxPollMs, outboxLeaseMs, outboxWakeConcurrency, outboxShutdownTimeoutMs,
    wakePumpTelemetry, workerId,
  } = resolved;
  let outboxPumpPromise: Promise<void> | undefined;
  const outboxPumpAbort = new AbortController();
  let wakeRecipientCursor = 0;

  function pumpOutbox(): Promise<void> {
    if (outboxPumpAbort.signal.aborted) return Promise.resolve();
    if (outboxPumpPromise !== undefined) return outboxPumpPromise;
    const operation = Promise.resolve()
      .then(async () => pumpOutboxOnce())
      .finally(() => {
        if (outboxPumpPromise === operation) outboxPumpPromise = undefined;
      });
    outboxPumpPromise = operation;
    return operation;
  }

  async function pumpOutboxOnce(): Promise<void> {
    wakePumpTelemetry.beginCycle();
    try {
      await pumpOutboxCycle();
    } catch (error) {
      if (outboxPumpAbort.signal.aborted) {
        wakePumpTelemetry.recordOutcome('cancelled');
        return;
      }
      wakePumpTelemetry.recordOutcome(
        error instanceof StoreError && error.code === 'fenced' ? 'fenced' : 'error'
      );
      throw error;
    } finally {
      wakePumpTelemetry.finishCycle();
    }
  }

  async function pumpOutboxCycle(): Promise<void> {
    if (outboxPumpAbort.signal.aborted) return;
    const sortedRecipients: FencedWakeOutboxRecipient[] = [...sessions.values()]
      .filter((session) => session.socket.readyState === WebSocket.OPEN)
      .map((session) => sessionFence(session))
      .sort((left, right) => sessionKey(left.tenant_id, left.alias)
        .localeCompare(sessionKey(right.tenant_id, right.alias)));
    if (sortedRecipients.length === 0) return;

    // Rotate the first entry each tick so the lexicographically first alias does not always
    // monopolise the first worker. The FIFO order of events within each identity is preserved by the store.
    const offset = wakeRecipientCursor % sortedRecipients.length;
    wakeRecipientCursor = (wakeRecipientCursor + 1) % sortedRecipients.length;
    const recipients = [
      ...sortedRecipients.slice(offset),
      ...sortedRecipients.slice(0, offset)
    ];
    // One SQL claim per cycle. PostgreSQL returns at most one row per requested identity in this
    // same rotated order, so an old backlog cannot monopolise all leases.
    const events = await repository.claimWakeOutbox(
      workerId,
      recipients,
      recipients.length,
      outboxLeaseMs,
      outboxPumpAbort.signal,
    );
    wakePumpTelemetry.markProgress();
    for (let claimed = 0; claimed < events.length; claimed += 1) {
      wakePumpTelemetry.markClaimed();
    }
    if (outboxPumpAbort.signal.aborted) {
      if (events.length === 0) wakePumpTelemetry.recordOutcome('cancelled');
      for (let cancelled = 0; cancelled < events.length; cancelled += 1) {
        wakePumpTelemetry.recordOutcome('cancelled');
      }
      return;
    }
    if (events.length > recipients.length) {
      throw new StoreError('fenced', 'wake outbox batch exceeded the requested identity count');
    }
    const recipientsByIdentity = new Map(
      recipients.map((recipient) => [sessionKey(recipient.tenant_id, recipient.alias), recipient]),
    );
    const seen = new Set<string>();
    for (const event of events) {
      const parsedAlias = AliasSchema.safeParse(event.payload.recipient_alias);
      const key = parsedAlias.success ? sessionKey(event.tenant_id, parsedAlias.data) : '';
      if (!parsedAlias.success || !recipientsByIdentity.has(key) || seen.has(key)) {
        throw new StoreError('fenced', 'wake outbox returned an invalid or duplicate batch identity');
      }
      seen.add(key);
    }
    const results = await allSettledBounded(
      events,
      outboxWakeConcurrency,
      async (event) => processWakeEvent(
        event,
        recipientsByIdentity,
        outboxPumpAbort.signal,
      ),
    );
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      wakePumpTelemetry.recordOutcome(
        result.reason instanceof StoreError && result.reason.code === 'fenced'
          ? 'fenced' : 'error'
      );
      app.log.error(result.reason);
    }
  }

  async function processWakeEvent(
    event: OutboxLeaseEvent,
    recipients: ReadonlyMap<string, FencedWakeOutboxRecipient>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      wakePumpTelemetry.recordOutcome('cancelled');
      return;
    }
    const parsedAlias = AliasSchema.safeParse(event.payload.recipient_alias);
    const key = parsedAlias.success ? sessionKey(event.tenant_id, parsedAlias.data) : '';
    const recipient = recipients.get(key);
    if (!parsedAlias.success || recipient === undefined) {
      throw new StoreError('fenced', 'wake outbox returned an event outside the requested recipient');
    }
    assertWakeClaimShape(event);
    const active = sessions.get(key);
    if (!active || active.socket.readyState !== WebSocket.OPEN
        || active.connectionToken !== recipient.connection_token
        || active.instanceId !== recipient.instance_id || active.epoch !== recipient.epoch) {
      const result = await ackWake(
        event,
        recipient,
        'retry',
        'recipient disconnected during wake delivery',
        signal,
      );
      wakePumpTelemetry.recordOutcome(result === 'dead' ? 'dead' : 'retry');
      return;
    }
    if (signal.aborted || active.abort.signal.aborted) {
      wakePumpTelemetry.recordOutcome('cancelled');
      return;
    }
    const renewed = await repository.renewWakeOutbox(
      wakeClaimFence(event, recipient),
      outboxLeaseMs,
      signal,
    );
    // No await is allowed between the SQL CAS and the frame. A local resume replaces `active`
    // synchronously; a remote resume rotates the same DB token and fences the later ACK.
    if (!renewed) throw new StoreError('fenced', 'wake outbox pre-send renewal was fenced');
    if (signal.aborted || active.abort.signal.aborted
        || sessions.get(key) !== active || active.socket.readyState !== WebSocket.OPEN
        || !send(active.socket, {
          type: 'wake', alias: active.alias, reason: 'delivery_available'
        })) {
      const result = await ackWake(
        event,
        recipient,
        'retry',
        'recipient disconnected during wake delivery',
        signal,
      );
      wakePumpTelemetry.recordOutcome(result === 'dead' ? 'dead' : 'retry');
      return;
    }
    const drained = await drain(active);
    if (!drained) {
      if (signal.aborted || active.abort.signal.aborted) {
        wakePumpTelemetry.recordOutcome('cancelled');
        return;
      }
      const result = await ackWake(
        event,
        recipient,
        'retry',
        'delivery drain did not complete',
        signal,
      );
      wakePumpTelemetry.recordOutcome(result === 'dead' ? 'dead' : 'retry');
      return;
    }
    await ackWake(event, recipient, 'sent', undefined, signal);
    wakePumpTelemetry.recordOutcome('sent');
  }

  function assertWakeClaimShape(event: OutboxLeaseEvent): void {
    const eventId = event.event_id ?? event.id;
    const attempt = event.attempt ?? event.attempts;
    const claimToken = event.claim_token;
    if (typeof eventId !== 'string' || eventId.length === 0
        || !Number.isInteger(attempt) || attempt < 1
        || typeof claimToken !== 'string' || claimToken.length === 0
        || event.claimed_by !== workerId) {
      throw new StoreError('fenced', 'wake outbox claim correlation is invalid');
    }
  }

  function wakeClaimFence(
    event: OutboxLeaseEvent,
    connection: ConnectionSessionFence,
  ): WakeOutboxClaimFence {
    assertWakeClaimShape(event);
    return {
      event_id: event.event_id ?? event.id,
      attempt: event.attempt ?? event.attempts,
      claim_token: event.claim_token,
      worker: workerId,
      connection,
    };
  }

  async function ackWake(
    event: OutboxLeaseEvent,
    connection: ConnectionSessionFence,
    status: 'sent' | 'retry',
    error: string | undefined,
    signal: AbortSignal,
  ): Promise<'sent' | 'failed' | 'dead'> {
    const fence = wakeClaimFence(event, connection);
    const result = await repository.ackOutbox({
      event_id: fence.event_id,
      attempt: fence.attempt,
      claim_token: fence.claim_token,
      connection,
      status,
      ...(error === undefined ? {} : { error }),
      ...(status === 'retry' ? { retry_after_ms: 250 } : {})
    }, signal);
    if (result.applied !== true) {
      throw new StoreError('fenced', 'wake outbox ACK was fenced');
    }
    const validStatus = result.status === 'sent' || result.status === 'failed'
      || result.status === 'dead';
    const expectedStatus = status === 'sent'
      ? result.status === 'sent'
      : result.status === 'failed' || result.status === 'dead';
    if (!validStatus || !expectedStatus) {
      throw new StoreError('fenced', 'wake outbox ACK returned an invalid terminal status');
    }
    return result.status;
  }

  async function start(): Promise<void> {
    const wakeSubscriber = options.deliveryWakeSubscriber ?? subscribeDeliveryWakes;
    const stopDeliveryWakes = await wakeSubscriber(options.pool, (notice) => {
      const tenant = TenantSchema.safeParse(notice.tenant_id);
      if (!tenant.success) return;
      const active = sessions.get(sessionKey(tenant.data, notice.alias));
      if (!active || active.socket.readyState !== WebSocket.OPEN) return;
      send(active.socket, { type: 'wake', alias: active.alias, reason: 'delivery_available' });
      void drain(active);
    });

    const timer = setInterval(() => {
      void pumpOutbox().catch((error: unknown) => app.log.error(error));
    }, outboxPollMs);
    timer.unref();

    app.addHook('onClose', async () => {
      clearInterval(timer);
      wakePumpTelemetry.markStopping();
      outboxPumpAbort.abort(new Error('gateway shutdown'));
      await stopDeliveryWakes();
      const closingSessions = [...sessions.values()];
      for (const session of closingSessions) {
        session.abort.abort(new Error('gateway shutdown'));
        if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
        session.expiryTimer = undefined;
        session.socket.close(1001, 'gateway shutdown');
      }
      // This timer is diagnostic only. Shutdown never abandons an await: abortable store operations
      // destroy their dedicated backend, settle, and are then joined below.
      const warning = setTimeout(() => {
        app.log.error(new Error(
          `gateway shutdown is still waiting for cancelled work after ${outboxShutdownTimeoutMs}ms`,
        ));
      }, outboxShutdownTimeoutMs);
      warning.unref();
      try {
        while (true) {
          const pending: Promise<unknown>[] = [
            ...(outboxPumpPromise === undefined ? [] : [outboxPumpPromise]),
            ...pendingDrains,
            ...pendingSessionTasks,
          ];
          if (pending.length === 0) break;
          const settled = await Promise.allSettled(pending);
          for (const outcome of settled) {
            if (outcome.status === 'rejected' && !outboxPumpAbort.signal.aborted) {
              app.log.error(outcome.reason);
            }
          }
        }
      } finally {
        clearTimeout(warning);
      }
      sessions.clear();
    });
  }

  return { pumpOutbox, start };
}
