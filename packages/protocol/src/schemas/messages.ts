import { z } from 'zod';
import {
  AliasSchema,
  AuthenticatedContextSchema,
  CanonicalUuidV4Schema,
  LaneSchema,
  OriginSchema,
  PROTOCOL_VERSION,
  RecipientSchema,
  RequestIdSchema,
  TenantSchema,
  TraceIdSchema,
} from './core.js';

export const MAX_ATTACHMENT_BYTES = 10_000_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 10_000_000;
/** MIME types accepted for attachments in platform messages. */
export const ATTACHMENT_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain',
  'text/markdown', 'text/x-markdown', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
] as const;

function hasUnsafeAttachmentCodePoint(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c ||
      (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb);
  });
}

const AttachmentNameSchema = z.string().min(1).max(255).superRefine((name, context) => {
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') ||
      hasUnsafeAttachmentCodePoint(name)) {
    context.addIssue({ code: 'custom', message: 'attachment name is unsafe' });
  }
});

export const AttachmentContentSchema = z.object({
  kind: z.enum(['image', 'document']),
  name: AttachmentNameSchema,
  mime_type: z.enum(ATTACHMENT_MIME_TYPES),
  file_size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  content_base64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
    .refine((value) => value.length % 4 === 0, 'attachment content is not valid base64')
}).strict().superRefine((attachment, context) => {
  const extension = (/\.[^.]+$/u.exec(attachment.name.toLowerCase()))?.[0];
  // Maps MIME type to the accepted extensions and the category (image | document).
  const expected = new Map<string, readonly [readonly string[], 'image' | 'document']>([
    ['image/jpeg', [['.jpg'], 'image']], ['image/png', [['.png'], 'image']],
    ['image/webp', [['.webp'], 'image']], ['application/pdf', [['.pdf'], 'document']],
    ['text/plain', [['.txt', '.md', '.csv'], 'document']],
    ['text/markdown', [['.md'], 'document']],
    ['text/x-markdown', [['.md'], 'document']],
    ['text/csv', [['.csv'], 'document']],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', [['.docx'], 'document']]
  ]).get(attachment.mime_type);
  if (expected === undefined || extension === undefined || !expected[0].includes(extension) ||
      attachment.kind !== expected[1]) {
    context.addIssue({ code: 'custom', message: 'attachment kind, MIME and extension do not agree' });
  }
  const padding = attachment.content_base64.endsWith('==') ? 2 : attachment.content_base64.endsWith('=') ? 1 : 0;
  const decodedSize = attachment.content_base64.length / 4 * 3 - padding;
  if (decodedSize !== attachment.file_size) {
    context.addIssue({ code: 'custom', path: ['file_size'], message: 'attachment encoded size does not agree' });
  }
});

export const AttachmentsV1Schema = z.array(AttachmentContentSchema)
  .min(1)
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .superRefine((attachments, context) => {
    if (attachments.reduce((total, attachment) => total + attachment.file_size, 0) > MAX_ATTACHMENTS_TOTAL_BYTES) {
      context.addIssue({ code: 'custom', message: 'aggregate attachment size exceeds limit' });
    }
  });

/** Upper bound on the timeout for an individual message (7 days). */
export const MAX_MESSAGE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

/** Execution budget granted to an individual message, in milliseconds. */
export const MessageTimeoutMsSchema = z.number().int().positive().max(MAX_MESSAGE_TIMEOUT_MS);

/** Safely reads and validates body.timeout_ms; returns undefined if it is invalid or absent. */
export function messageTimeoutMs(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const parsed = MessageTimeoutMsSchema.safeParse((body as Record<string, unknown>).timeout_ms);
  return parsed.success ? parsed.data : undefined;
}

export const MessageBodySchema = z.record(z.string(), z.unknown()).superRefine((body, context) => {
  if (body.timeout_ms !== undefined) {
    const timeout = MessageTimeoutMsSchema.safeParse(body.timeout_ms);
    if (!timeout.success) {
      context.addIssue({
        code: 'custom',
        path: ['timeout_ms'],
        message: `body.timeout_ms must be an integer between 1 and ${MAX_MESSAGE_TIMEOUT_MS}`
      });
    }
  }
  if (body.attachments_v1 === undefined) return;
  const parsed = AttachmentsV1Schema.safeParse(body.attachments_v1);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({ ...issue, path: ['attachments_v1', ...issue.path] });
  }
});

/** Internal authenticated publish command. Identity and origin are populated by the gateway. */
export const PublishMessageSchema = z.object({
  version: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  request_id: RequestIdSchema,
  trace_id: TraceIdSchema,
  tenant_id: TenantSchema,
  room_id: z.string().min(1).max(128),
  actor_alias: AliasSchema,
  recipients: z.array(RecipientSchema).max(100),
  body: MessageBodySchema,
  idempotency_key: z.string().min(1).max(200),
  origin: OriginSchema.optional(),
  session_id: z.string().min(1).max(256).optional(),
  channel: z.string().min(1).max(128).optional(),
  authenticated_context: AuthenticatedContextSchema.optional(),
  lane: LaneSchema.default('interactive'),
  priority: z.number().int().min(-100).max(100).default(0)
}).strict();

/**
 * `body.type` values used for agent-to-agent messages:
 * `agent.message`, `agent.response`, and `agent.fanin`.
 */
export const AGENT_TO_AGENT_MESSAGE_TYPES = [
  'agent.message',
  'agent.response',
  'agent.fanin'
] as const;

/** Operational probe reserved for gateway validation. */
export const SYSTEM_GATE_PROBE_MESSAGE_TYPE = 'system.gate.probe' as const;
/** Closed technical principals: never destinations and never appearing in routing_targets. */
export const SYSTEM_PRINCIPAL_ALIASES = ['gate-probe', 'quota-collector'] as const;
export const SystemGateProbeBodySchema = z.object({
  type: z.literal(SYSTEM_GATE_PROBE_MESSAGE_TYPE),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  timeout_ms: MessageTimeoutMsSchema,
}).strict();
export type SystemGateProbeBody = z.infer<typeof SystemGateProbeBodySchema>;

export function isSystemGateProbeBody(body: unknown): body is SystemGateProbeBody {
  return SystemGateProbeBodySchema.safeParse(body).success;
}

/** Reserved internal message types that clients cannot publish directly. */
export const RESERVED_INTERNAL_MESSAGE_TYPES = [
  ...AGENT_TO_AGENT_MESSAGE_TYPES,
  'agent.notify'
] as const;

const ReservedInternalMessageTypes = new Set<string>(RESERVED_INTERNAL_MESSAGE_TYPES);
const AgentToAgentMessageTypes = new Set<string>(AGENT_TO_AGENT_MESSAGE_TYPES);

/** Whether the message body corresponds to agent-to-agent communication. */
export function isAgentToAgentBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const type = (body as Record<string, unknown>).type;
  return typeof type === 'string' && AgentToAgentMessageTypes.has(type);
}

const AuthenticatedPublishBodySchema = MessageBodySchema.superRefine(
  (body, context) => {
    if (typeof body.type === 'string' && ReservedInternalMessageTypes.has(body.type)) {
      context.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'reserved internal message types cannot be published by clients'
      });
    }
  }
);

/** Public HTTP/console payload. It deliberately has no actor, tenant, session, channel or origin fields. */
export const AuthenticatedPublishSchema = z.object({
  room_id: z.string().min(1).max(128),
  recipients: z.array(RecipientSchema).max(100),
  body: AuthenticatedPublishBodySchema,
  idempotency_key: z.string().min(1).max(200),
  lane: LaneSchema.default('interactive'),
  // A caller may ASK for anything in range; the gateway holds every non-operator principal at
  // AGENT_PRIORITY_CEILING before the command reaches the store. Enforcing the ceiling here
  // instead would reject the request, and a 400 on a canary or on an over-eager adapter is a
  // worse outcome than a clamped number.
  priority: z.number().int().min(-100).max(100).default(0)
}).strict();

/**
 * Console preflight for a durable publish intent. The server supplies the opaque idempotency key
 * after binding this exact semantic command to the authenticated principal; a browser can never
 * choose or forge that key through this surface.
 */
export const ConsolePublishIntentPrepareSchema = AuthenticatedPublishSchema.omit({
  idempotency_key: true,
}).safeExtend({
  /** Fresh per deliberate submit; retries of that submit reuse it. */
  intent_nonce: CanonicalUuidV4Schema,
}).strict();

/** Proactive egress. An agent never names a chat: it names a logical handle an operator created. */
export const NOTIFY_KINDS = ['task_complete', 'decision_request', 'digest', 'alert'] as const;
export const NotifyKindSchema = z.enum(NOTIFY_KINDS);
export const EgressHandleSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
export const MAX_NOTIFY_BODY_BYTES = 4_096;

/* The cap is BYTES and the store measures bytes: as a plain `.max()` the schema counted UTF-16
   units, so an accented body between the two counts passed the wire and died later against
   `body_too_large` — one limit rejecting at a different size on each layer. */
const NotifyBodySchema = z.string().min(1).refine(
  (body) => Buffer.byteLength(body, 'utf8') <= MAX_NOTIFY_BODY_BYTES,
  { message: `notify body must not exceed ${String(MAX_NOTIFY_BODY_BYTES)} bytes` },
);

/**
 * Public proactive-egress payload. Like AuthenticatedPublishSchema it deliberately
 * has no actor, tenant, session, channel, origin or conversation_id: the only
 * destination a caller can express is a handle that is already on the allowlist.
 */
export const NotifyRequestSchema = z.object({
  destination: EgressHandleSchema,
  kind: NotifyKindSchema,
  body: NotifyBodySchema,
  idempotency_key: z.string().min(1).max(200),
  dry_run: z.boolean().default(false)
}).strict();

export const CreateJobSchema = z.object({
  lane: LaneSchema,
  priority: z.number().int().min(-100).max(100),
  kind: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown())
}).strict();
