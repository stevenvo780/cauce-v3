import { OriginSchema, TenantSchema } from '@cauce/protocol';
import type { CauceRepository } from '@cauce/store';
import type { OriginRelayAck, OriginRelayEvent, OriginRelayRepository } from './types.js';

interface HardenedOutboxStore {
  claimOutbox(kind: 'origin_relay', workerId: string, limit: number, leaseMs: number, adapter?: string): Promise<unknown[]>;
  ackOutbox?(acknowledgement: OriginRelayAck): Promise<unknown>;
  completeOutbox?(eventId: string, workerId: string, claimToken: string): Promise<boolean>;
  retryOutbox?(
    eventId: string,
    workerId: string,
    claimToken: string,
    delayMs: number,
    error: string
  ): Promise<'retry' | 'dead' | 'fenced'>;
}

interface AppliedOutboxAck {
  readonly status: 'sent' | 'failed' | 'dead';
  readonly applied: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid origin relay lease');
  return value as Record<string, unknown>;
}

function appliedAck(value: unknown): AppliedOutboxAck {
  const result = record(value);
  if ((result.status !== 'sent' && result.status !== 'failed' && result.status !== 'dead') ||
      typeof result.applied !== 'boolean') {
    throw new Error('origin relay outbox ACK returned an invalid result');
  }
  return result as unknown as AppliedOutboxAck;
}

function requiredString(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`origin relay lease has invalid ${name}`);
  }
  return value;
}

function parseEvent(value: unknown): OriginRelayEvent {
  const row = record(value);
  const eventId = requiredString(row.event_id, 'event_id');
  const attempt = row.attempt;
  const storeAttempt = attempt ?? row.attempts;
  const maxAttempts = row.max_attempts;
  if (!Number.isInteger(storeAttempt) || Number(storeAttempt) < 1 ||
      !Number.isInteger(maxAttempts) || Number(maxAttempts) < 1) {
    throw new Error('origin relay lease has invalid attempt limits');
  }
  const tenant = TenantSchema.safeParse(row.tenant_id);
  const origin = OriginSchema.safeParse(row.origin);
  if (!tenant.success || !origin.success) throw new Error('origin relay lease has invalid authenticated origin');
  const payload = record(row.payload);
  const deliveryId = row.delivery_id;
  if (deliveryId !== null && typeof deliveryId !== 'string') throw new Error('origin relay lease has invalid delivery_id');
  return {
    event_id: eventId,
    attempt: Number(storeAttempt),
    max_attempts: Number(maxAttempts),
    claim_token: requiredString(row.claim_token, 'claim_token'),
    tenant_id: tenant.data,
    adapter: requiredString(row.adapter, 'adapter', 64),
    request_id: requiredString(row.request_id, 'request_id'),
    message_id: requiredString(row.message_id, 'message_id'),
    delivery_id: deliveryId,
    trace_id: requiredString(row.trace_id, 'trace_id', 256),
    origin: origin.data,
    payload
  };
}

/** Adapter for the store's fenced outbox lease contract. Legacy unfenced methods are refused. */
export class StoreOriginRelayRepository implements OriginRelayRepository {
  private readonly store: HardenedOutboxStore;
  private readonly claims = new Map<string, { workerId: string; attempt: number; claimToken: string }>();

  constructor(repository: CauceRepository | HardenedOutboxStore) {
    this.store = repository;
    if (typeof this.store.claimOutbox !== 'function' ||
        (typeof this.store.ackOutbox !== 'function' &&
         (typeof this.store.completeOutbox !== 'function' || typeof this.store.retryOutbox !== 'function'))) {
      throw new Error('hardened outbox lease/ACK repository is required');
    }
  }

  async claim(workerId: string, limit: number, leaseMs: number, adapter: string): Promise<OriginRelayEvent[]> {
    // Adapter-scoped claim (G1): the store filters `adapter=$5`, so the worker only
    // ever leases events for adapters it serves and never poaches e.g. 'telegram'.
    const events = (await this.store.claimOutbox('origin_relay', workerId, limit, leaseMs, adapter)).map((value) => {
      const row = record(value);
      return parseEvent({ ...row, event_id: row.event_id ?? row.id, attempt: row.attempt ?? row.attempts });
    });
    for (const event of events) {
      this.claims.set(event.event_id, { workerId, attempt: event.attempt, claimToken: event.claim_token });
    }
    return events;
  }

  async ack(acknowledgement: OriginRelayAck): Promise<void> {
    const claim = this.claims.get(acknowledgement.event_id);
    if (!claim || claim.attempt !== acknowledgement.attempt || claim.claimToken !== acknowledgement.claim_token) {
      throw new Error('origin relay ACK does not match an active local lease');
    }
    try {
      if (this.store.ackOutbox) {
        const result = appliedAck(await this.store.ackOutbox(acknowledgement));
        const expected = acknowledgement.status === 'retry' ? 'failed' : acknowledgement.status;
        if (!result.applied || result.status !== expected) {
          throw new Error('origin relay outbox ACK was fenced');
        }
        return;
      }
      if (acknowledgement.status === 'sent') {
        const applied = await this.store.completeOutbox!(
          acknowledgement.event_id, claim.workerId, acknowledgement.claim_token
        );
        if (!applied) throw new Error('origin relay sent ACK was fenced');
        return;
      }
      const result = await this.store.retryOutbox!(
        acknowledgement.event_id,
        claim.workerId,
        acknowledgement.claim_token,
        acknowledgement.status === 'retry' ? acknowledgement.retry_after_ms ?? 0 : 0,
        acknowledgement.error ?? 'origin relay delivery failed'
      );
      if (result === 'fenced') throw new Error('origin relay retry/DLQ ACK was fenced');
    } finally {
      this.claims.delete(acknowledgement.event_id);
    }
  }
}
