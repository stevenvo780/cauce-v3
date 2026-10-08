import type { LiveState } from '../live/agent-state';
import type { TranscriptItem } from '../terminal/session';
import { humanAuthor } from '../terminal/message-author';
import { optimisticMessageOf } from './optimistic-message';
import type { CanonicalReply } from './use-canonical-reply';

/** Consecutive messages from the same author closer than this share one header. */
const GROUP_WINDOW_MS = 5 * 60_000;

type TypingState = 'thinking' | 'receiving';

export type ThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; item: TranscriptItem; side: 'operator' | 'agent'; startsGroup: boolean }
  | { kind: 'reply'; key: string; item: TranscriptItem; reply: CanonicalReply; startsGroup: boolean };

/** The canonical reply belongs to this row only when message, delivery and recipient all match. */
export function replyFor(item: TranscriptItem, reply: CanonicalReply | readonly CanonicalReply[] | undefined): CanonicalReply | undefined {
  if (Array.isArray(reply)) return (reply as readonly CanonicalReply[]).find((candidate) => replyFor(item, candidate));
  const single = reply as CanonicalReply | undefined;
  const delivery = item.delivery;
  if (!single || !delivery) return undefined;
  return single.messageId === item.message.message_id
    && single.deliveryId === delivery.delivery_id
    && single.tenantId === delivery.recipient_tenant
    && single.alias === delivery.recipient_alias ? single : undefined;
}

/** Partial text is never shown: only a closed chain with a terminal status counts as an answer. */
export function replyConsolidated(reply: CanonicalReply): boolean {
  return reply.chainOpen === false && ['done', 'failed', 'dead'].includes(reply.status ?? '');
}

function replyHasContent(reply: CanonicalReply): boolean {
  return (typeof reply.reply === 'string' && reply.reply.trim().length > 0) || Boolean(reply.replyAttachments?.length);
}

function visibleReply(item: TranscriptItem, reply: CanonicalReply | readonly CanonicalReply[] | undefined): CanonicalReply | undefined {
  const candidates: readonly CanonicalReply[] = Array.isArray(reply) ? reply as readonly CanonicalReply[] : reply ? [reply as CanonicalReply] : [];
  return candidates.find((candidate) => replyFor(item, candidate) && replyHasContent(candidate) && replyConsolidated(candidate));
}

function echoedByOutput(items: readonly TranscriptItem[], root: TranscriptItem, reply: CanonicalReply): boolean {
  const trace = root.message.trace_id;
  if (!trace) return false;
  const attachments = (entries: CanonicalReply['replyAttachments']) => JSON.stringify((entries ?? [])
    .map((entry) => [entry.name, entry.mime_type, entry.file_size, entry.sha256]));
  return items.some((item) => item.direction === 'output' && item.message.trace_id === trace
    && item.message.tenant_id === reply.tenantId && item.message.actor_alias === reply.alias
    && (item.message.body_preview ?? '') === (reply.reply ?? '')
    && attachments(item.message.attachments ?? undefined) === attachments(reply.replyAttachments));
}

function authorKey(item: TranscriptItem): string {
  if (item.direction === 'output') return `agent:${item.message.tenant_id ?? ''}:${item.message.actor_alias ?? ''}`;
  const author = humanAuthor(item.message);
  return author ? `human:${author.subject_id}` : `actor:${item.message.tenant_id ?? ''}:${item.message.actor_alias ?? ''}`;
}

function localDayKey(time: number): string {
  const date = new Date(time);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1)}-${String(date.getDate())}`;
}

export function dayLabel(time: number, now = Date.now()): string {
  const key = localDayKey(time);
  if (key === localDayKey(now)) return 'Hoy';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDayKey(yesterday.getTime())) return 'Ayer';
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat('es', {
    weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }),
  }).format(time);
}

/**
 * Flattens the transcript into what the thread draws: day separators, messages and the agent's
 * consolidated replies, each marked with whether it opens a new author group. Kept flat on purpose
 * so a reply stays a sibling of the message it answers.
 */
export function threadRows(items: readonly TranscriptItem[], reply: CanonicalReply | readonly CanonicalReply[] | undefined, now = Date.now()): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let lastDay: string | undefined;
  let lastAuthor: string | undefined;
  let lastTime = Number.NaN;
  const push = (row: ThreadRow & { kind: 'message' | 'reply' }, author: string, time: number) => {
    const day = Number.isNaN(time) ? lastDay : localDayKey(time);
    if (day !== undefined && day !== lastDay) {
      rows.push({ kind: 'day', key: `day-${day}`, label: dayLabel(time, now) });
      lastDay = day;
      lastAuthor = undefined;
    }
    row.startsGroup = author !== lastAuthor || Number.isNaN(time) || Number.isNaN(lastTime) || time - lastTime > GROUP_WINDOW_MS;
    rows.push(row);
    lastAuthor = author;
    lastTime = time;
  };
  items.forEach((item, index) => {
    const time = Date.parse(item.message.created_at ?? '');
    const key = optimisticMessageOf(item)?.clientId ?? item.message.message_id ?? `${item.direction}-${String(index)}`;
    push({ kind: 'message', key, item, side: item.direction === 'output' ? 'agent' : 'operator', startsGroup: true }, authorKey(item), time);
    const answer = item.direction === 'input' ? visibleReply(item, reply) : undefined;
    if (answer && !echoedByOutput(items, item, answer)) push({ kind: 'reply', key: `${key}-reply`, item, reply: answer, startsGroup: true }, `agent:${answer.tenantId}:${answer.alias}`, time);
  });
  return rows;
}

const CLAIMED = new Set(['leased', 'accepted', 'started']);
const WAITING = new Set(['pending', 'retry']);

/**
 * Whether the agent is visibly "typing": the newest row of the thread is a message TO the agent
 * that it has not answered yet and whose delivery is still in flight. Claimed or working reads as
 * thinking, queued as receiving; without a delivery status only the live state can tell. A down
 * or stuck agent never types: that would hide the fault.
 */
export function typingState({ items, reply, live }: {
  items: readonly TranscriptItem[];
  reply?: CanonicalReply | readonly CanonicalReply[];
  live?: LiveState;
}): TypingState | undefined {
  const last = items.at(-1);
  if (last?.direction !== 'input' || !last.delivery || live === 'down' || live === 'blocked') return undefined;
  if (visibleReply(last, reply)) return undefined;
  const status = last.delivery.status;
  if (status && CLAIMED.has(status)) return 'thinking';
  if (status && WAITING.has(status)) return 'receiving';
  if (status) return undefined;
  return live === 'thinking' || live === 'receiving' ? live : undefined;
}
