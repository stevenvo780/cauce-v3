import type { Origin, Tenant } from '@cauce/protocol';

export interface OriginRelayEvent {
  readonly event_id: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly claim_token: string;
  readonly tenant_id: Tenant;
  readonly adapter: string;
  readonly request_id: string;
  readonly message_id: string;
  readonly delivery_id: string | null;
  readonly trace_id: string;
  readonly origin: Origin;
  readonly payload: Record<string, unknown>;
}

export interface OriginRelayAck {
  readonly event_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly status: 'sent' | 'retry' | 'dead';
  readonly error?: string;
  readonly retry_after_ms?: number;
}

export interface OriginRelayRepository {
  /**
   * Claim pending `origin_relay` leases for a SINGLE adapter. The claim is always
   * adapter-scoped: the worker never issues an unscoped claim. An unscoped claim
   * would steal (and DLQ) events belonging to adapters this worker does not serve
   * — most importantly `telegram`, which is owned by the telegram-bridge (gap G1).
   */
  claim(workerId: string, limit: number, leaseMs: number, adapter: string): Promise<OriginRelayEvent[]>;
  ack(acknowledgement: OriginRelayAck): Promise<void>;
}

export interface OriginTransportResult {
  readonly provider_message_id?: string;
  readonly duplicate?: boolean;
}

export interface OriginTransport {
  send(event: OriginRelayEvent): Promise<OriginTransportResult>;
}

export interface OriginTransportRegistry {
  forAdapter(adapter: string): OriginTransport | undefined;
  /**
   * The exact, finite set of adapters this worker serves (registered from
   * `CAUCE_RELAY_ADAPTERS`). The worker iterates this set to claim per adapter,
   * so it can only ever claim events for adapters it is explicitly configured for.
   */
  adapters(): readonly string[];
}

export class OriginTransportError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'OriginTransportError';
  }
}
