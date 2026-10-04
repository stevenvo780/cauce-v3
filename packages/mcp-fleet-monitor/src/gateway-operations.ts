import { z } from 'zod';
import {
  AliasSchema, AuthenticatedPublishSchema, CanonicalUuidV4Schema, DeliveryStateSchema,
  ConsolePublishIntentReconciliationSchema, ConsolePublishIntentExpiredSchema, ConsolePublishIntentRateLimitedSchema,
  PublishResultSchema, RecipientSchema, TenantSchema, type PublishResult, type Tenant,
} from '@cauce/protocol';
import { GatewayReadError, MAX_GATEWAY_ITEMS, projectGatewayAgents, projectGatewayStatus } from './gateway-projection.js';
import type { VerifiedOAuthIdentity } from './gateway-oauth-identity.js';

export interface McpSubmitCommand {
  readonly request_key: string;
  readonly room_id: string;
  readonly recipients: readonly { readonly tenant_id: Tenant; readonly alias: string }[];
  readonly body: Readonly<Record<string, unknown>>;
}
export interface HumanMcpReceipt {
  readonly message_id: string;
  readonly deliveries: readonly {
    readonly delivery_id: string; readonly tenant_id: string; readonly alias: string;
    readonly status: string; readonly attempt: number; readonly terminal_at: string | null;
    readonly reply: string | null;
  }[];
  readonly chain_open: boolean;
}
export interface HumanGatewayOperations {
  status(): Promise<unknown>;
  agents(): Promise<unknown>;
  submit(command: McpSubmitCommand): Promise<PublishResult>;
  receipt(messageId: string): Promise<HumanMcpReceipt>;
}
export interface GatewayOperationsFactory {
  forRequest(identity: VerifiedOAuthIdentity, signal: AbortSignal): Promise<Readonly<HumanGatewayOperations>>;
}
export interface GatewayRequestContext {
  readonly factory: GatewayOperationsFactory;
  readonly identity: VerifiedOAuthIdentity;
  readonly signal: AbortSignal;
}

export const McpSubmitCommandSchema = AuthenticatedPublishSchema.pick({
  room_id: true, recipients: true, body: true,
}).safeExtend({ request_key: CanonicalUuidV4Schema, recipients: z.array(RecipientSchema).min(1).max(100) }).strict();
export const ReceiptInputSchema = z.object({ message_id: CanonicalUuidV4Schema }).strict();
export const HumanMcpReceiptSchema = z.object({
  message_id: CanonicalUuidV4Schema,
  deliveries: z.array(z.object({
    delivery_id: CanonicalUuidV4Schema,
    tenant_id: TenantSchema,
    alias: AliasSchema,
    status: DeliveryStateSchema,
    attempt: z.number().int().min(0).max(2147483647),
    terminal_at: z.iso.datetime({ offset: true }).nullable(),
    reply: z.string().nullable(),
  }).strict()).min(1).max(100),
  chain_open: z.boolean(),
}).strict();
export { PublishResultSchema };

export function projectHumanGatewayRead(name: 'cauce_status' | 'cauce_agents', value: unknown): unknown {
  const invalid = (): never => { throw new GatewayReadError('gateway_response_invalid'); };
  const record = (data: unknown): Record<string, unknown> => {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return invalid();
    return data as Record<string, unknown>;
  };
  const data = record(value);
  const tenant = TenantSchema.parse(data.tenant_id);
  const collection = name === 'cauce_status' ? record(data.presence) : data;
  if (!Array.isArray(collection.items) || collection.items.length > MAX_GATEWAY_ITEMS
    || typeof collection.total !== 'number' || !Number.isSafeInteger(collection.total)
    || collection.total < collection.items.length || typeof collection.truncated !== 'boolean'
    || collection.truncated !== (collection.total > collection.items.length)
    || collection.items.some((item: unknown) => record(item).tenant_id !== tenant)) return invalid();
  if (name === 'cauce_agents') {
    const projected = projectGatewayAgents({ items: collection.items }, tenant);
    return { ...projected, total: collection.total, truncated: collection.truncated };
  }
  const projected = projectGatewayStatus({ version: data.version, presence: collection.items }, tenant);
  if (typeof data.online !== 'number' || !Number.isSafeInteger(data.online) || data.online < projected.online
    || data.online > collection.total || (!collection.truncated && data.online !== projected.online)) return invalid();
  return { ...projected, online: data.online,
    presence: { items: projected.presence.items, total: collection.total, truncated: collection.truncated } };
}

export const GatewayOperationFailureSchema = z.union([
  z.object({ status_code: z.literal(400), error: z.literal('invalid_request') }).strict(),
  z.object({ status_code: z.literal(401), error: z.literal('unauthorized') }).strict(),
  z.object({ status_code: z.literal(403), error: z.literal('forbidden') }).strict(),
  z.object({ status_code: z.literal(404), error: z.literal('not_found') }).strict(),
  z.object({ status_code: z.literal(409), error: z.literal('operation_conflict'),
    safe_to_retry_same_request_key: z.literal(true).optional() }).strict(),
  z.object({ status_code: z.literal(503), error: z.literal('operation_unavailable'),
    safe_to_retry_same_request_key: z.literal(true).optional() }).strict(),
  ConsolePublishIntentReconciliationSchema.extend({ status_code: z.literal(409) }).strict(),
  ConsolePublishIntentExpiredSchema.extend({ status_code: z.literal(410) }).strict(),
  ConsolePublishIntentRateLimitedSchema.extend({ status_code: z.literal(429) }).strict(),
]);
export type GatewayOperationFailure = z.infer<typeof GatewayOperationFailureSchema>;
export class GatewayOperationError extends Error {
  readonly failure: Readonly<GatewayOperationFailure>;
  constructor(failure: GatewayOperationFailure) {
    super(failure.error);
    this.failure = Object.freeze(GatewayOperationFailureSchema.parse(failure));
  }
}
