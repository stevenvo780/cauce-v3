import { describe, expect, it } from 'vitest';
import { CoalescingBuffer } from '../src/media-group.js';
import { MAX_TEXT_CHUNKS, TEXT_CHUNK_MAX_GAP_SECONDS, TEXT_CHUNK_SETTLE_MS } from '../src/text-chunks.js';
import type { TelegramUpdate } from '../src/types.js';

const CHAT = 201;
const USER = 101;
const FULL = 'a'.repeat(4_096);

function text(
  updateId: number,
  body: string,
  date: number,
  overrides: { chatId?: number; userId?: number; threadId?: number } = {}
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 700,
      date,
      from: { id: overrides.userId ?? USER },
      chat: { id: overrides.chatId ?? CHAT, type: 'private' },
      ...(overrides.threadId === undefined ? {} : { message_thread_id: overrides.threadId }),
      text: body
    }
  };
}

function photo(updateId: number, date: number, mediaGroupId?: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 700,
      date,
      from: { id: USER },
      chat: { id: CHAT, type: 'private' },
      caption: 'foto',
      photo: [{ file_id: `f${String(updateId)}`, file_unique_id: `u${String(updateId)}` }],
      ...(mediaGroupId === undefined ? {} : { media_group_id: mediaGroupId })
    }
  };
}

function started(): CoalescingBuffer {
  const buffer = new CoalescingBuffer();
  buffer.beginCycle();
  return buffer;
}

describe('CoalescingBuffer — the pieces Telegram cuts from one long text', () => {
  it('holds a full-length text and closes the batch when its short tail arrives', () => {
    const buffer = started();
    const head = text(1, FULL, 100);
    const tail = text(2, 'y fin', 100);

    expect(buffer.accept(head, 0)).toEqual([]);
    expect(buffer.accept(tail, 200)).toEqual([[head, tail]]);
    expect(buffer.holds(1)).toBe(false);
  });

  it('keeps holding while every piece is full and closes at the cap', () => {
    const buffer = started();
    const pieces = Array.from({ length: MAX_TEXT_CHUNKS }, (_, index) => text(index + 1, FULL, 100));

    const batches = pieces.map((piece, index) => buffer.accept(piece, index * 10));

    expect(batches.slice(0, -1).every((batch) => batch.length === 0)).toBe(true);
    expect(batches.at(-1)).toEqual([pieces]);
  });

  it('publishes a lone full-length text once the settle window elapses', () => {
    const buffer = started();
    const head = text(1, FULL, 100);

    expect(buffer.accept(head, 1_000)).toEqual([]);
    expect(buffer.settled(1_000 + TEXT_CHUNK_SETTLE_MS - 1)).toBeUndefined();
    expect(buffer.settled(1_000 + TEXT_CHUNK_SETTLE_MS)).toEqual([head]);
  });

  it('waits across poll cycles instead of closing at the cycle boundary', () => {
    const buffer = started();
    const head = text(1, FULL, 100);
    const tail = text(2, 'y fin', 101);

    expect(buffer.accept(head, 0)).toEqual([]);
    expect(buffer.settled(10)).toBeUndefined();
    buffer.beginCycle();
    expect(buffer.holds(1)).toBe(true);
    expect(buffer.settled(20)).toBeUndefined();
    buffer.beginCycle();
    expect(buffer.accept(tail, 30)).toEqual([[head, tail]]);
  });

  it('measures the settle window from the last piece, not from the first', () => {
    const buffer = started();
    const first = text(1, FULL, 100);
    const second = text(2, FULL, 101);

    expect(buffer.accept(first, 0)).toEqual([]);
    expect(buffer.accept(second, TEXT_CHUNK_SETTLE_MS - 100)).toEqual([]);
    expect(buffer.settled(TEXT_CHUNK_SETTLE_MS + 100)).toBeUndefined();
    expect(buffer.settled(TEXT_CHUNK_SETTLE_MS - 100 + TEXT_CHUNK_SETTLE_MS)).toEqual([first, second]);
  });

  it('never glues a short text to the one before it', () => {
    const buffer = started();
    const first = text(1, 'hola', 100);
    const second = text(2, 'chau', 100);

    expect(buffer.accept(first, 0)).toEqual([[first]]);
    expect(buffer.accept(second, 1)).toEqual([[second]]);
  });

  it.each([
    ['another chat', { chatId: 202 }],
    ['another user', { userId: 102 }],
    ['another thread', { threadId: 7 }]
  ])('does not continue a full text with a message from %s', (_label, overrides) => {
    const buffer = started();
    const head = text(1, FULL, 100);
    const other = text(2, 'y fin', 100, overrides);

    expect(buffer.accept(head, 0)).toEqual([]);
    expect(buffer.accept(other, 1)).toEqual([[head], [other]]);
  });

  it('does not continue a full text with a piece dated beyond the gap Telegram leaves between pieces', () => {
    const buffer = started();
    const head = text(1, FULL, 100);
    const late = text(2, 'mensaje humano independiente', 100 + TEXT_CHUNK_MAX_GAP_SECONDS + 1);

    expect(buffer.accept(head, 0)).toEqual([]);
    expect(buffer.accept(late, 1)).toEqual([[head], [late]]);
  });

  it('does not continue a full text with a message that carries no date', () => {
    const buffer = started();
    const head = text(1, FULL, 100);
    const { date: _date, ...undatedMessage } = text(2, 'y fin', 100).message!;
    const undated: TelegramUpdate = { update_id: 2, message: undatedMessage };

    expect(buffer.accept(head, 0)).toEqual([]);
    expect(buffer.accept(undated, 1)).toEqual([[head], [undated]]);
  });

  it('closes an open text chain when a media message from the same sender arrives', () => {
    const buffer = started();
    const head = text(1, FULL, 100);
    const single = photo(2, 100);

    expect(buffer.accept(head, 0)).toEqual([]);
    expect(buffer.accept(single, 1)).toEqual([[head], [single]]);
  });

  it('closes an open text chain when an album starts, and an open album when a full text arrives', () => {
    const buffer = started();
    const head = text(1, FULL, 100);
    const member = photo(2, 100, 'album-1');
    const anotherHead = text(3, FULL, 100);

    expect(buffer.accept(head, 0)).toEqual([]);
    expect(buffer.accept(member, 1)).toEqual([[head]]);
    expect(buffer.accept(anotherHead, 2)).toEqual([[member]]);
    expect(buffer.holds(3)).toBe(true);
  });
});
