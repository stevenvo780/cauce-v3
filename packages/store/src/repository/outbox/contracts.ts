import type { Origin, OutboxAck as ProtocolOutboxAck, Tenant } from '@cauce/protocol';
import { UUID_PATTERN } from '../observability.js';

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
 * Destinatario conectado que puede recibir un wake durable en este instante.
 *
 * El par completo es intencional: los alias no son globales y filtrar sólo por alias permite que
 * una sesión de otro tenant reclame (y queme) el wake de un destinatario desconectado.
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
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function visibleText(value: unknown): string {
  if (typeof value !== 'string' || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(value)) return '';
  return value.trim();
}

export function textualReply(result: Record<string, unknown> | undefined): string {
  const output = objectRecord(result?.output);
  return visibleText(output?.reply);
}
