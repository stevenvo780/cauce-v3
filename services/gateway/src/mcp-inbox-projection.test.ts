import { describe, expect, it } from 'vitest';
import { StoreError, type HumanInboxItem, type HumanInboxPage } from '@cauce/store';
import { HUMAN_MCP_INBOX_MAX_BYTES, HumanMcpInboxSchema } from '@cauce/mcp-fleet-monitor/gateway-http';
import { encodeInboxCursor, humanInboxQuery, projectHumanInbox, truncateUtf8 } from './mcp-inbox-projection.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-03T12:00:00.123456Z';

function uuid(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function item(index: number, reply: string | null = `reply ${String(index)}`, deliveries = 1): HumanInboxItem {
  return {
    key: { at: AT, id: uuid(index) }, messageId: uuid(index), createdAt: AT, lastActivityAt: AT, roomId: 'grp.steven',
    from: { tenantId: 'Steven', alias: 'kant' }, text: `root ${String(index)}`, chainOpen: reply === null,
    deliveries: Array.from({ length: deliveries }, (_, slot) => ({
      deliveryId: uuid(10_000 + index * 100 + slot), tenantId: 'Steven', alias: 'jarvis', status: reply === null ? 'started' : 'done',
      attempt: 1, terminalAt: reply === null ? null : '2026-10-03T12:00:01.000000+00:00', reply,
    })),
    questions: [{ gateId: uuid(90_000 + index), askedBy: { tenantId: 'Steven', alias: 'jarvis' }, question: '¿Seguimos?',
      status: 'open', createdAt: '2026-10-03T12:00:02.000Z', answeredAt: null }],
    chainMessages: [{ messageId: uuid(80_000 + index), createdAt: '2026-10-03T12:00:03.000Z',
      from: { tenantId: 'Steven', alias: 'jarvis' }, type: 'agent.message', text: 'back to kant', deliveryStatus: 'pending' }],
    chainMessagesTruncated: false,
  };
}

function page(items: HumanInboxItem[], extra: Partial<HumanInboxPage> = {}): HumanInboxPage {
  return { items, withheld: 0, ...extra };
}

function storeCode(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return error instanceof StoreError ? error.code : 'other'; }
  return undefined;
}

describe('human MCP inbox projection', () => {
  it('cuts UTF-8 at a character boundary and flags the cut', () => {
    expect(truncateUtf8('abc', 3)).toEqual({ value: 'abc', truncated: false });
    expect(truncateUtf8('aé', 2)).toEqual({ value: 'a', truncated: true });
    expect(truncateUtf8('a😀b', 4)).toEqual({ value: 'a', truncated: true });
    expect(truncateUtf8('a😀b', 5)).toEqual({ value: 'a😀', truncated: true });
    expect(Buffer.byteLength(truncateUtf8('ñ'.repeat(5000), 4097).value, 'utf8')).toBe(4096);
  });

  it('projects a recent page with the untrusted field list and no cursor when nothing follows', () => {
    const query = humanInboxQuery({}, USER_A);
    expect(query).toEqual({ mode: 'recent', limit: 20, openOnly: false });
    const projected = projectHumanInbox(page([item(1), item(2, null)]), query, USER_A);
    expect(HumanMcpInboxSchema.parse(projected)).toEqual(projected);
    expect(projected.next_cursor).toBeNull();
    expect(projected.watermark).toBeUndefined();
    expect(projected.untrusted_fields).toContain('items[].deliveries[].reply');
    expect(projected.items.map((entry) => entry.chain_open)).toEqual([false, true]);
    expect(projected.items[0]?.chain_messages[0]).toMatchObject({ consumed_by_agent: true, delivery_status: 'pending' });
    expect(JSON.stringify(projected)).not.toMatch(/"answer"|answered_by/u);
  });

  it('keeps the state hash stable across activity clocks and changes it with the reply', () => {
    const query = humanInboxQuery({}, USER_A);
    const first = projectHumanInbox(page([item(1)]), query, USER_A).items[0];
    const later = projectHumanInbox(page([{ ...item(1), lastActivityAt: '2026-10-04T00:00:00.000000Z' }]), query, USER_A).items[0];
    const changed = projectHumanInbox(page([item(1, 'another reply')]), query, USER_A).items[0];
    expect(later?.state_hash).toBe(first?.state_hash);
    expect(changed?.state_hash).not.toBe(first?.state_hash);
  });

  it('round-trips a microsecond cursor for its owner and refuses it for another human', () => {
    const query = humanInboxQuery({ limit: 2, open_only: true }, USER_A);
    const projected = projectHumanInbox(page([item(1), item(2)], { next: { at: AT, id: uuid(2) } }), query, USER_A);
    const cursor = projected.next_cursor;
    if (cursor === null) throw new Error('expected a next cursor');
    expect(humanInboxQuery({ cursor, limit: 2 }, USER_A)).toEqual({ mode: 'recent', limit: 2, openOnly: true,
      after: { at: AT, id: uuid(2) } });
    expect(storeCode(() => humanInboxQuery({ cursor }, USER_B))).toBe('invalid_input');
    expect(storeCode(() => humanInboxQuery({ cursor, open_only: false }, USER_A))).toBe('invalid_input');
    expect(storeCode(() => humanInboxQuery({ cursor: 'bm90LWpzb24' }, USER_A))).toBe('invalid_input');
    expect(storeCode(() => humanInboxQuery({ cursor: Buffer.from(JSON.stringify({ v: 1, m: 'feed', t: AT, id: uuid(2),
      o: false, h: '0'.repeat(16) })).toString('base64url') }, USER_A))).toBe('invalid_input');
  });

  it('keeps the feed since and watermark in the page and its cursor', () => {
    const since = '2026-10-03T00:00:00.000Z';
    const query = humanInboxQuery({ since }, USER_A);
    expect(query).toEqual({ mode: 'feed', limit: 20, openOnly: false, since });
    const projected = projectHumanInbox(page([item(1)], { next: { at: AT, id: uuid(1) }, watermark: AT }), query, USER_A);
    expect(projected.watermark).toBe(AT);
    const cursor = projected.next_cursor;
    if (cursor === null) throw new Error('expected a feed cursor');
    expect(encodeInboxCursor(query, AT, uuid(1), USER_A)).toBe(cursor);
    expect(humanInboxQuery({ cursor }, USER_A)).toMatchObject({ mode: 'feed', since, after: { at: AT, id: uuid(1) } });
  });

  it('stops before the byte budget and resumes after the last item shown', () => {
    const query = humanInboxQuery({ limit: 50 }, USER_A);
    const items = Array.from({ length: 50 }, (_, index) => item(index + 1, 'x'.repeat(8_000), 1));
    const projected = projectHumanInbox(page(items), query, USER_A);
    const shown = projected.items.length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(50);
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8')).toBeLessThanOrEqual(HUMAN_MCP_INBOX_MAX_BYTES);
    const cursor = projected.next_cursor;
    if (cursor === null) throw new Error('expected a cursor at the byte cut');
    expect(humanInboxQuery({ cursor }, USER_A).after).toEqual({ at: AT, id: uuid(shown) });
  });

  it('degrades a single oversized item to 1 KiB replies instead of failing', () => {
    const query = humanInboxQuery({}, USER_A);
    const projected = projectHumanInbox(page([item(1, 'y'.repeat(9_000), 60)]), query, USER_A);
    expect(projected.items).toHaveLength(1);
    expect(projected.items[0]?.deliveries.every((delivery) => delivery.reply?.length === 1024 && delivery.reply_truncated)).toBe(true);
    expect(projected.withheld).toBe(0);
  });

  it('carries the store withheld count and rejects an item the contract cannot express', () => {
    const query = humanInboxQuery({}, USER_A);
    expect(projectHumanInbox(page([], { withheld: 3 }), query, USER_A)).toMatchObject({ items: [], withheld: 3, next_cursor: null });
    expect(storeCode(() => projectHumanInbox(page([{ ...item(1), deliveries: [] }]), query, USER_A))).toBe('conflict');
    expect(storeCode(() => projectHumanInbox(page([{ ...item(1), from: { tenantId: 'Steven', alias: 'Not An Alias' } }]),
      query, USER_A))).toBe('conflict');
  });
});
