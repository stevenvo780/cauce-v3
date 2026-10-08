import { createHash } from 'node:crypto';
import { isAnyUuid } from '@cauce/protocol';
import { StoreError, type ClientMailboxPage, type ClientMailboxQuery } from '@cauce/store';
import type { HumanMcpMailbox, HumanMcpMailboxQuery } from '@cauce/mcp-fleet-monitor/gateway-http';

export function mailboxCursorOwner(human: string, tenant: string, grant: string | undefined): string {
  return createHash('sha256').update(JSON.stringify(['client-mailbox:v1', human, tenant, grant])).digest('hex');
}
export function clientMailboxQuery(input: HumanMcpMailboxQuery, owner: string): ClientMailboxQuery {
  let after: ClientMailboxQuery['after'];
  if (input.cursor !== undefined) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      const cursor = parsed as Record<string, unknown>;
      if (Object.keys(cursor).sort().join(',') !== 'at,id,owner,v' || cursor.v !== 1 || cursor.owner !== owner
          || typeof cursor.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(cursor.at)
          || !Number.isFinite(Date.parse(cursor.at)) || !isAnyUuid(cursor.id)) throw new Error('invalid');
      after = { at: cursor.at, id: cursor.id };
    } catch { throw new StoreError('invalid_input', 'invalid client mailbox cursor'); }
  }
  return { limit: input.limit ?? 20, ...(after === undefined ? {} : { after }) };
}
export function projectClientMailbox(page: ClientMailboxPage | null, owner: string): HumanMcpMailbox | null {
  if (page === null) return null;
  const items: ClientMailboxPage['items'][number][] = [];
  let next = page.next;
  for (const item of page.items) {
    if (Buffer.byteLength(JSON.stringify([...items, item])) > 128 * 1024) {
      const last = items.at(-1);
      if (last !== undefined) next = { at: last.stored_at, id: last.delivery_id };
      break;
    }
    items.push(item);
  }
  const { next: _next, ...data } = page;
  return { ...data, items, next_cursor: next === undefined ? null
    : Buffer.from(JSON.stringify({ v: 1, owner, ...next })).toString('base64url'),
  untrusted_fields: ['items[].text'], reading_confirms_execution: false };
}
