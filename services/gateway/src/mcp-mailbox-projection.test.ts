import { describe, expect, it } from 'vitest';
import { StoreError, type ClientMailboxPage } from '@cauce/store';
import { HumanMcpMailboxSchema } from '@cauce/mcp-fleet-monitor/gateway-http';
import { clientMailboxQuery, mailboxCursorOwner, projectClientMailbox } from './mcp-mailbox-projection.js';

const HUMAN = '11111111-1111-4111-8111-111111111111';
const GRANT = '22222222-2222-4222-8222-222222222222';
const OWNER = mailboxCursorOwner(HUMAN, 'Steven', GRANT);
const AT = '2026-10-06T12:00:00.123456Z';

function uuid(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}
function page(count = 1, text = 'ping'): ClientMailboxPage {
  return { address: { tenant_id: 'Steven', alias: `mbx-${'a'.repeat(48)}` }, label: 'Cronos',
    items: Array.from({ length: count }, (_, index) => ({ delivery_id: uuid(index + 1), message_id: uuid(index + 101),
      stored_at: AT, from: { tenant_id: 'Steven', alias: 'jarvis' }, text, text_truncated: false, state: 'stored' })) };
}
function cursor(extra: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({ v: 1, owner: OWNER, at: AT, id: uuid(1), ...extra })).toString('base64url');
}
function expectInvalidCursor(value: string): void {
  let failure: unknown;
  try { clientMailboxQuery({ cursor: value }, OWNER); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(StoreError);
  expect(failure).toMatchObject({ code: 'invalid_input', message: 'invalid client mailbox cursor' });
}

describe('client mailbox read projection', () => {
  it('binds cursors to human, tenant and grant while retaining a stable connection owner', () => {
    expect(mailboxCursorOwner(HUMAN, 'Steven', GRANT)).toBe(OWNER);
    expect(mailboxCursorOwner(uuid(9), 'Steven', GRANT)).not.toBe(OWNER);
    expect(mailboxCursorOwner(HUMAN, 'Isa', GRANT)).not.toBe(OWNER);
    expect(mailboxCursorOwner(HUMAN, 'Steven', uuid(9))).not.toBe(OWNER);
  });
  it('passes through a null page and defaults the query', () => {
    expect(projectClientMailbox(null, OWNER)).toBeNull();
    expect(clientMailboxQuery({}, OWNER)).toEqual({ limit: 20 });
  });
  it('returns full untrusted text and stored transport without claiming execution', () => {
    const source = page(1, 'Hola 📬, respuesta completa');
    const projected = projectClientMailbox(source, OWNER);
    expect(HumanMcpMailboxSchema.parse(projected)).toEqual(projected);
    expect(projected).toMatchObject({ items: source.items, next_cursor: null,
      reading_confirms_execution: false, untrusted_fields: ['items[].text'] });
  });
  it('round-trips microseconds and the last delivery when storage has another page', () => {
    const next = { at: AT, id: uuid(1) };
    const projected = projectClientMailbox({ ...page(), next }, OWNER);
    if (!projected?.next_cursor) throw new Error('Expected a mailbox continuation');
    expect(clientMailboxQuery({ limit: 3, cursor: projected.next_cursor }, OWNER)).toEqual({ limit: 3, after: next });
    expect(projected).not.toHaveProperty('next');
  });
  it('bounds the page by bytes without truncating Unicode or skipping the withheld messages', () => {
    const text = '📬'.repeat(3000);
    const source = page(12, text);
    const projected = projectClientMailbox({ ...source, next: { at: AT, id: uuid(12) } }, OWNER);
    if (!projected?.next_cursor) throw new Error('Expected a bounded mailbox continuation');
    expect(HumanMcpMailboxSchema.parse(projected)).toEqual(projected);
    expect(projected.items.length).toBeGreaterThan(0);
    expect(projected.items.length).toBeLessThan(source.items.length);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(128 * 1024);
    expect(projected.items.every(item => item.text === text && !item.text_truncated)).toBe(true);
    const last = projected.items.at(-1);
    expect(clientMailboxQuery({ cursor: projected.next_cursor }, OWNER).after)
      .toEqual({ at: last?.stored_at, id: last?.delivery_id });
    expect(source.items).toHaveLength(12);
  });
  it.each([
    { owner: mailboxCursorOwner(HUMAN, 'Steven', uuid(9)) }, { v: 2 }, { extra: true },
    { id: 'not-a-uuid' }, { at: '2026-10-06T99:00:00.123456Z' }, { at: '2026-10-06T12:00:00.123Z' },
  ])('rejects an invalid or foreign continuation %j', extra => {
    expectInvalidCursor(cursor(extra));
  });
  it.each([
    '!', Buffer.from('null').toString('base64url'), Buffer.from('[]').toString('base64url'),
  ])('rejects malformed cursor %s', value => {
    expectInvalidCursor(value);
  });
});
