import {
  isRfcUuid, objectRecord, visibleText,
  type Origin, type OutboxAck as ProtocolOutboxAck, type Tenant
} from '@cauce/protocol';

export { objectRecord, visibleText };

export interface OutboxEvent {
  id: string;
  tenant_id: Tenant;
  adapter: string;
  kind: 'wake' | 'origin_relay';
  request_id: string;
  message_id: string;
  delivery_id: string | null;
  trace_id: string;
  origin: Origin | null;
  payload: Record<string, unknown>;
  attempts: number;
  attempt?: number;
  max_attempts: number;
  claimed_by: string;
  claim_token: string;
  claim_expires_at: Date;
  event_id?: string;
}

export interface ClaimedOutboxEvent extends OutboxEvent {
  max_attempts: number;
  claimed_by: string;
  claim_token: string;
  claim_expires_at: Date;
  event_id: string;
  attempt: number;
}

/**
 * Connected recipient that can receive a durable wake at this instant.
 *
 * The full pair is intentional: aliases are not global, and filtering only by alias would let a
 * session from another tenant claim (and burn) the wake of an offline recipient.
 */
export interface WakeOutboxRecipient {
  readonly tenant_id: Tenant;
  readonly alias: string;
  /**
   * Legacy direct store callers may omit the session fields. The gateway runtime always supplies
   * all three; a partial fence is rejected before SQL.
   */
  readonly instance_id?: string;
  readonly epoch?: number;
  readonly connection_token?: string;
}

export interface FencedWakeOutboxRecipient extends WakeOutboxRecipient {
  readonly instance_id: string;
  readonly epoch: number;
  readonly connection_token: string;
}

export interface ConnectionSessionFence {
  readonly tenant_id: Tenant;
  readonly alias: string;
  readonly instance_id: string;
  readonly epoch: number;
  readonly connection_token: string;
}

export type OutboxRetryResult = 'retry' | 'dead' | 'fenced';

export type OutboxAck = ProtocolOutboxAck & {
  readonly connection?: ConnectionSessionFence;
};

export interface WakeOutboxClaimFence {
  readonly event_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly worker: string;
  readonly connection: ConnectionSessionFence;
}

export function validConnectionToken(value: unknown): value is string {
  return isRfcUuid(value);
}

export function textualReply(result: Record<string, unknown> | undefined): string {
  const output = objectRecord(result?.output);
  return visibleText(output?.reply);
}
