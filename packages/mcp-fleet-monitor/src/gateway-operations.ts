import { z } from 'zod';
import {
  AliasSchema, AuthenticatedPublishSchema, CanonicalUuidV4Schema, DeliveryStateSchema,
  ConsolePublishIntentReconciliationSchema, ConsolePublishIntentExpiredSchema, ConsolePublishIntentRateLimitedSchema,
  PublishResultSchema, RecipientSchema, Sha256HexSchema, TenantSchema, type PublishResult, type Tenant,
} from '@cauce/protocol';
import { MAX_GATEWAY_BYTES } from './gateway-client.js';
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
  inbox(query: HumanMcpInboxQuery): Promise<HumanMcpInbox>;
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
export const HUMAN_MCP_INBOX_MAX_ITEMS = 50;
export const HUMAN_MCP_INBOX_MAX_BYTES = MAX_GATEWAY_BYTES - 8 * 1024;
export const HUMAN_MCP_INBOX_TEXT_BYTES = Object.freeze({ reply: 8 * 1024, degradedReply: 1024, text: 4 * 1024, preview: 1024 });
export const HUMAN_MCP_INBOX_UNTRUSTED_FIELDS = Object.freeze([
  'items[].text', 'items[].deliveries[].reply', 'items[].questions[].question', 'items[].chain_messages[].text',
] as const);
export const InboxInputSchema = z.object({
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  limit: z.number().int().min(1).max(HUMAN_MCP_INBOX_MAX_ITEMS).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  open_only: z.boolean().optional(),
}).strict().refine((value) => value.cursor === undefined || value.since === undefined, 'a cursor carries its own mode');
export type HumanMcpInboxQuery = z.infer<typeof InboxInputSchema>;
const InboxPrincipalSchema = z.object({ tenant_id: TenantSchema, alias: AliasSchema }).strict();
const InboxInstantSchema = z.iso.datetime({ offset: true });
export const HumanMcpInboxSchema = z.object({
  items: z.array(z.object({
    message_id: CanonicalUuidV4Schema,
    created_at: InboxInstantSchema,
    last_activity_at: InboxInstantSchema,
    room_id: z.string().min(1).max(128),
    from: InboxPrincipalSchema,
    text: z.string().nullable(),
    text_truncated: z.boolean(),
    chain_open: z.boolean(),
    state_hash: Sha256HexSchema,
    deliveries: z.array(HumanMcpReceiptSchema.shape.deliveries.element.extend({ reply_truncated: z.boolean() }).strict())
      .min(1).max(100),
    questions: z.array(z.object({
      gate_id: CanonicalUuidV4Schema, asked_by: InboxPrincipalSchema, question: z.string(), question_truncated: z.boolean(),
      status: z.enum(['open', 'answered', 'cancelled']), created_at: InboxInstantSchema, answered_at: InboxInstantSchema.nullable(),
    }).strict()).max(5),
    chain_messages: z.array(z.object({
      message_id: CanonicalUuidV4Schema, created_at: InboxInstantSchema, from: InboxPrincipalSchema,
      type: z.string().max(128).nullable(), text: z.string().nullable(), text_truncated: z.boolean(),
      delivery_status: DeliveryStateSchema, consumed_by_agent: z.literal(true),
    }).strict()).max(10),
    chain_messages_truncated: z.boolean(),
  }).strict()).max(HUMAN_MCP_INBOX_MAX_ITEMS),
  next_cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u).nullable(),
  watermark: InboxInstantSchema.optional(),
  withheld: z.number().int().min(0).max(HUMAN_MCP_INBOX_MAX_ITEMS),
  untrusted_fields: z.tuple([
    z.literal(HUMAN_MCP_INBOX_UNTRUSTED_FIELDS[0]), z.literal(HUMAN_MCP_INBOX_UNTRUSTED_FIELDS[1]),
    z.literal(HUMAN_MCP_INBOX_UNTRUSTED_FIELDS[2]), z.literal(HUMAN_MCP_INBOX_UNTRUSTED_FIELDS[3]),
  ]),
}).strict();
export type HumanMcpInbox = z.infer<typeof HumanMcpInboxSchema>;
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
