import type { TelegramEntity, TelegramMessage, TelegramUpdate } from './types.js';

/* Telegram cuts a text longer than its limit into consecutive messages: same chat, same sender, same thread,
   dated seconds apart at most, every piece but the last one full. The pieces are rejoined here so the agent
   reads the whole message instead of the first piece. Design notes: ./README.md */
export const TEXT_CHUNK_MIN_CHARACTERS = 4_000;
export const TEXT_CHUNK_MAX_GAP_SECONDS = 5;
export const TEXT_CHUNK_SETTLE_MS = 2_000;
export const MAX_TEXT_CHUNKS = 32;
export const MAX_CHAINED_TEXT_CHARACTERS = 4_096 * MAX_TEXT_CHUNKS;

export interface TextPiece {
  readonly message: TelegramMessage;
  readonly chat: string;
  readonly user: string;
  readonly thread: string;
  readonly date: number;
  /** A piece as long as Telegram's cut: the message may go on in the next update. */
  readonly full: boolean;
}

export function textPiece(update: TelegramUpdate): TextPiece | undefined {
  const message = update.message;
  if (message === undefined || typeof message.text !== 'string' || message.text.length === 0) return undefined;
  if (message.media_group_id !== undefined) return undefined;
  if (message.entities?.some((entity) => entity.type === 'bot_command' && entity.offset === 0)) return undefined;
  const chat = (message as { chat?: { id?: unknown } }).chat?.id;
  const user = message.from?.id;
  const date = message.date;
  if (!Number.isSafeInteger(chat) || !Number.isSafeInteger(user) || !Number.isSafeInteger(date)) return undefined;
  return {
    message,
    chat: String(chat),
    user: String(user),
    thread: String(message.message_thread_id ?? 0),
    date: Number(date),
    full: message.text.length >= TEXT_CHUNK_MIN_CHARACTERS
  };
}

/** Whether `next` is the piece Telegram sent right after `previous` when it cut one text. */
export function continuesText(previous: TelegramUpdate, next: TelegramUpdate): boolean {
  const before = textPiece(previous);
  const after = textPiece(next);
  if (before === undefined || after === undefined || !before.full) return false;
  return before.chat === after.chat && before.user === after.user && before.thread === after.thread &&
    Math.abs(after.date - before.date) <= TEXT_CHUNK_MAX_GAP_SECONDS;
}

/** The first piece's message carrying the whole text, entities shifted by the UTF-16 length before them. */
export function chainedMessage(messages: readonly TelegramMessage[]): TelegramMessage {
  const [first, ...rest] = messages;
  if (first === undefined) throw new Error('a text chain needs at least one piece');
  let text = first.text ?? '';
  const entities: TelegramEntity[] = [...(first.entities ?? [])];
  for (const piece of rest) {
    const offset = text.length;
    for (const entity of piece.entities ?? []) entities.push({ ...entity, offset: entity.offset + offset });
    text += piece.text ?? '';
  }
  return { ...first, text, ...(entities.length === 0 ? {} : { entities }) };
}
