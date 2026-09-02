import { canonicalJson, sha256Hex } from './canonical.js';
import type { PublishMessage, PublishResult } from './schemas.js';

/** The semantic request hash stored durably beside an idempotency key. */
export function publishRequestHash(input: PublishMessage): string {
  const semanticCommand: Record<string, unknown> = { ...input };
  // A retry necessarily gets a new transport request/trace pair. Everything else is semantic.
  delete semanticCommand.request_id;
  delete semanticCommand.trace_id;
  return sha256Hex(JSON.stringify(canonicalJson(semanticCommand)));
}

export type ConsolePublishIntentCommand = Omit<PublishMessage, 'idempotency_key'> & {
  readonly intent_nonce: string;
  /** Public priority requested before the authenticated gateway applies its current policy. */
  readonly requested_priority: number;
};

/**
 * Policy-stable meaning of the public console submission. Operator scope is enforced separately
 * by the server journal, so ephemeral auth and the effective priority policy are absent here.
 */
export function consolePublishIntentRequestedHash(input: Pick<
  ConsolePublishIntentCommand,
  'room_id' | 'recipients' | 'body' | 'lane' | 'requested_priority'
>): string {
  const requested = {
    room_id: input.room_id,
    recipients: [...input.recipients].sort((left, right) => (
      `${left.tenant_id}\u0000${left.alias}`.localeCompare(`${right.tenant_id}\u0000${right.alias}`)
    )),
    body: input.body,
    lane: input.lane,
    requested_priority: input.requested_priority,
  };
  return sha256Hex(
    `cauce-v3:console-publish-requested-intent:v1\n${JSON.stringify(canonicalJson(requested))}`,
  );
}

/**
 * Stable server-side identity for one console publish meaning. Transport correlation and the
 * opaque key and ephemeral auth/session/origin data are deliberately excluded. Tenant, actor,
 * routing, body, lane and effective priority remain bound, so a refresh or relogin by the same
 * subject can recover the durable effect without letting another subject claim it. Unlike
 * publishRequestHash this has no historical rows, so it carries an explicit domain separator.
 */
export function consolePublishIntentSemanticHash(
  input: ConsolePublishIntentCommand | PublishMessage,
): string {
  const semanticCommand = {
    tenant_id: input.tenant_id,
    actor_alias: input.actor_alias,
    room_id: input.room_id,
    recipients: [...input.recipients].sort((left, right) => (
      `${left.tenant_id}\u0000${left.alias}`.localeCompare(`${right.tenant_id}\u0000${right.alias}`)
    )),
    body: input.body,
    lane: input.lane,
    priority: input.priority,
  };
  return sha256Hex(
    `cauce-v3:console-publish-intent:v1\n${JSON.stringify(canonicalJson(semanticCommand))}`,
  );
}

export type PublishReceiptCausalFields = Pick<
  PublishResult,
  | 'tenant_id'
  | 'actor_alias'
  | 'idempotency_key'
  | 'request_hash'
  | 'request_id'
  | 'trace_id'
  | 'message_id'
  | 'delivery_ids'
>;

/**
 * Binds the exact durable effect to the semantic request that created it.
 *
 * This is deliberately a digest, not a new secret or signature. The authenticated gateway
 * recomputes it after receiving the store result; its purpose is to reject mixed/stale receipts,
 * while the store remains the authority for the durable message and delivery rows.
 */
export function publishReceiptCausalHash(receipt: PublishReceiptCausalFields): string {
  const material = {
    actor_alias: receipt.actor_alias,
    delivery_ids: receipt.delivery_ids,
    idempotency_key: receipt.idempotency_key,
    message_id: receipt.message_id,
    request_hash: receipt.request_hash,
    request_id: receipt.request_id,
    tenant_id: receipt.tenant_id,
    trace_id: receipt.trace_id,
  };
  return sha256Hex(`cauce-v3:publish-receipt:v1\n${JSON.stringify(canonicalJson(material))}`);
}

export interface DurablePublishEffect {
  readonly message_id: string;
  readonly delivery_ids: string[];
  readonly duplicate: boolean;
  readonly request_id: string;
  readonly trace_id: string;
}

/** Build the one protocol-owned receipt from an authenticated command and a durable effect. */
export function buildPublishReceipt(
  command: PublishMessage,
  effect: DurablePublishEffect,
): PublishResult {
  const requestHash = publishRequestHash(command);
  const causal = {
    tenant_id: command.tenant_id,
    actor_alias: command.actor_alias,
    idempotency_key: command.idempotency_key,
    request_hash: requestHash,
    request_id: effect.request_id,
    trace_id: effect.trace_id,
    message_id: effect.message_id,
    delivery_ids: [...effect.delivery_ids],
  };
  return {
    ...causal,
    duplicate: effect.duplicate,
    causal_hash: publishReceiptCausalHash(causal),
  };
}
