import { createHash } from 'node:crypto';
import { CanonicalUuidV4Schema } from '@cauce/protocol';
import { HUMAN_INBOX_MAX_LIMIT, StoreError, type HumanInboxItem, type HumanInboxPage, type HumanInboxQuery } from '@cauce/store';
import {
  HUMAN_MCP_INBOX_MAX_BYTES, HUMAN_MCP_INBOX_TEXT_BYTES, HUMAN_MCP_INBOX_UNTRUSTED_FIELDS, HumanMcpInboxSchema,
  InboxInputSchema, type HumanMcpInbox, type HumanMcpInboxQuery,
} from '@cauce/mcp-fleet-monitor/gateway-http';

export const HUMAN_MCP_INBOX_DEFAULT_LIMIT = 20;
const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const CURSOR_KEYS = new Set(['v', 'm', 't', 'id', 's', 'o', 'h']);
// A cursor is opaque but not secret: the owner digest only stops one human's page from being replayed by another.
interface InboxCursor {
  readonly v: 1; readonly m: 'recent' | 'feed'; readonly t: string; readonly id: string;
  readonly s?: string; readonly o: boolean; readonly h: string;
}

function inboxCursor(value: unknown): InboxCursor | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const cursor = value as Record<string, unknown>;
  const since = cursor.s;
  const valid = Object.keys(cursor).every((key) => CURSOR_KEYS.has(key)) && cursor.v === 1
    && (cursor.m === 'recent' || cursor.m === 'feed') && typeof cursor.t === 'string' && MICRO_ISO.test(cursor.t)
    && CanonicalUuidV4Schema.safeParse(cursor.id).success && typeof cursor.o === 'boolean'
    && typeof cursor.h === 'string' && /^[0-9a-f]{16}$/u.test(cursor.h)
    && (cursor.m === 'feed') === (since !== undefined)
    && (since === undefined || InboxInputSchema.safeParse({ since }).success);
  return valid ? cursor as unknown as InboxCursor : undefined;
}
type InboxItem = HumanMcpInbox['items'][number];

function owner(userId: string): string {
  return createHash('sha256').update(JSON.stringify(['cauce-v3:human-mcp-inbox:v1', userId])).digest('hex').slice(0, 16);
}

function invalid(): never {
  throw new StoreError('invalid_input', 'invalid human inbox cursor');
}

export function encodeInboxCursor(query: HumanInboxQuery, at: string, id: string, userId: string): string {
  const cursor = inboxCursor({ v: 1, m: query.mode, t: at, id, ...(query.since === undefined ? {} : { s: query.since }),
    o: query.openOnly, h: owner(userId) });
  if (cursor === undefined) throw new StoreError('conflict', 'human inbox position is not a valid cursor');
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function humanInboxQuery(input: HumanMcpInboxQuery, userId: string): HumanInboxQuery {
  const limit = input.limit ?? HUMAN_MCP_INBOX_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HUMAN_INBOX_MAX_LIMIT) invalid();
  if (input.cursor === undefined) {
    return Object.freeze({ mode: input.since === undefined ? 'recent' : 'feed', limit, openOnly: input.open_only ?? false,
      ...(input.since === undefined ? {} : { since: input.since }) });
  }
  if (input.since !== undefined) invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
  } catch {
    invalid();
  }
  const cursor = inboxCursor(decoded);
  if (cursor?.h !== owner(userId)
      || (input.open_only !== undefined && input.open_only !== cursor.o)) invalid();
  return Object.freeze({ mode: cursor.m, limit, openOnly: cursor.o, after: Object.freeze({ at: cursor.t, id: cursor.id }),
    ...(cursor.s === undefined ? {} : { since: cursor.s }) });
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  // Back off to the lead byte of a character the cut would split.
  while (end > 0 && (encoded.readUInt8(end) & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString('utf8'), truncated: true };
}

function nullableText(value: string | null, maxBytes: number): { value: string | null; truncated: boolean } {
  return value === null ? { value: null, truncated: false } : truncateUtf8(value, maxBytes);
}

function projectItem(item: HumanInboxItem, replyBytes: number): InboxItem {
  const preview = nullableText(item.text, HUMAN_MCP_INBOX_TEXT_BYTES.preview);
  const state = {
    message_id: item.messageId, created_at: item.createdAt, room_id: item.roomId,
    from: { tenant_id: item.from.tenantId, alias: item.from.alias },
    text: preview.value, text_truncated: preview.truncated, chain_open: item.chainOpen,
    deliveries: item.deliveries.map((delivery) => {
      const reply = nullableText(delivery.reply, replyBytes);
      return { delivery_id: delivery.deliveryId, tenant_id: delivery.tenantId, alias: delivery.alias, status: delivery.status,
        ...(delivery.clientMailbox === undefined ? {} : { client_mailbox: delivery.clientMailbox }),
        attempt: delivery.attempt, terminal_at: delivery.terminalAt, reply: reply.value, reply_truncated: reply.truncated };
    }),
    questions: item.questions.map((question) => {
      const text = truncateUtf8(question.question, HUMAN_MCP_INBOX_TEXT_BYTES.text);
      return { gate_id: question.gateId, asked_by: { tenant_id: question.askedBy.tenantId, alias: question.askedBy.alias },
        question: text.value, question_truncated: text.truncated, status: question.status,
        created_at: question.createdAt, answered_at: question.answeredAt };
    }),
    chain_messages: item.chainMessages.map((message) => {
      const text = nullableText(message.text, HUMAN_MCP_INBOX_TEXT_BYTES.text);
      return { message_id: message.messageId, created_at: message.createdAt,
        from: { tenant_id: message.from.tenantId, alias: message.from.alias }, type: message.type,
        text: text.value, text_truncated: text.truncated, delivery_status: message.deliveryStatus, consumed_by_agent: true as const };
    }),
    chain_messages_truncated: item.chainMessagesTruncated,
  };
  // The hash covers what the reader acts on, not the activity clock, so a feed client dedupes re-sent items.
  const stateHash = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const parsed = HumanMcpInboxSchema.shape.items.element.safeParse({ ...state, last_activity_at: item.lastActivityAt, state_hash: stateHash });
  if (!parsed.success) throw new StoreError('conflict', 'human inbox item is incomplete');
  return parsed.data;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Adds items while the serialized page stays under the MCP byte budget. An item that cannot fit
 * even with 1 KiB replies is withheld (cauce_receipt still reads it); the cursor resumes after
 * the last item shown, so nothing past the cut is skipped.
 */
export function projectHumanInbox(page: HumanInboxPage, query: HumanInboxQuery, userId: string, byteBudget = HUMAN_MCP_INBOX_MAX_BYTES): HumanMcpInbox {
  const items: InboxItem[] = [];
  let withheld = page.withheld;
  let cut: HumanInboxItem | undefined;
  const envelope = (next: string | null) => ({
    items, next_cursor: next, ...(page.watermark === undefined ? {} : { watermark: page.watermark }),
    withheld, untrusted_fields: [...HUMAN_MCP_INBOX_UNTRUSTED_FIELDS],
  });
  const reserve = bytes(envelope('x'.repeat(512)));
  let used = reserve;
  for (const [index, item] of page.items.entries()) {
    const full = projectItem(item, HUMAN_MCP_INBOX_TEXT_BYTES.reply);
    const fitting = used + bytes(full) + 1 <= byteBudget ? full
      : items.length === 0 ? projectItem(item, HUMAN_MCP_INBOX_TEXT_BYTES.degradedReply) : undefined;
    if (fitting === undefined) {
      cut = page.items[index - 1];
      break;
    }
    if (used + bytes(fitting) + 1 > byteBudget) {
      withheld += 1;
      continue;
    }
    items.push(fitting);
    used += bytes(fitting) + 1;
  }
  const resume = cut?.key ?? page.next;
  const next = resume === undefined ? null : encodeInboxCursor(query, resume.at, resume.id, userId);
  const parsed = HumanMcpInboxSchema.safeParse(envelope(next));
  if (!parsed.success) throw new StoreError('conflict', 'human inbox page is incomplete');
  return parsed.data;
}
