import { describe, expect, it, vi } from 'vitest';
import { CauceRepository, type DatabasePool } from '../../index.js';
import { DISPOSABLE_AUDIT_ACTIONS } from '../observability/policy.js';
import { MESSAGE_AUTHOR_SQL, messageAuthor, requireConsoleAuthor, withMessageAuthor } from './author.js';

const author = { kind: 'human' as const, subject_id: `human:${'a'.repeat(64)}`, display_name: 'Steven' };

describe('durable message author projection', () => {
  it('accepts only the bounded server provenance snapshot', () => {
    expect(messageAuthor(author)).toEqual(author);
    expect(messageAuthor({ ...author, display_name: null })).toMatchObject({ display_name: null });
    for (const value of [null, {}, [], { ...author, subject_id: 'email@example.test' },
      { ...author, kind: 'agent' }, { ...author, display_name: '' }, { ...author, display_name: 'x'.repeat(241) },
      { ...author, email: 'private@example.test' }]) expect(messageAuthor(value)).toBeUndefined();
  });

  it('requires the authenticated console intent and copies the snapshot', () => {
    expect(requireConsoleAuthor(undefined, false)).toBeUndefined();
    expect(() => requireConsoleAuthor(author, false)).toThrow('human provenance requires an authenticated console intent');
    expect(() => requireConsoleAuthor({}, true)).toThrow('human provenance requires an authenticated console intent');
    const copy = requireConsoleAuthor(author, true);
    expect(copy).toEqual(author);
    expect(copy).not.toBe(author);
  });

  it('never derives authorship from a body, origin, tenant or technical alias', () => {
    const historical = { tenant_id: 'Steven', actor_alias: 'kant', body: { author }, origin: { metadata: { author } } };
    expect(withMessageAuthor(historical).author).toBeNull();
    expect(withMessageAuthor({ ...historical, author: { ...author, subject_id: 'forged' } }).author).toBeNull();
    expect(withMessageAuthor({ ...historical, author }).author).toEqual(author);
  });

  it('requires one exact durable publication binding and survives telemetry retention', () => {
    for (const clause of ['count(*)=1', 'author_audit.trace_id=m.trace_id', 'author_audit.request_id=m.request_id',
      'author_audit.message_id=m.id', 'author_audit.tenant_id=m.tenant_id', 'author_audit.actor_alias=m.actor_alias',
      "author_audit.action='message.publish'", "author_audit.decision='allow'"]) expect(MESSAGE_AUTHOR_SQL).toContain(clause);
    expect(DISPOSABLE_AUDIT_ACTIONS).not.toContain('message.publish');
  });

  it('adds the provenance projection without replacing the existing visibility-bound queries', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('SELECT policy.allow_read') ? [{ allow_read: true }] : [{
        id: 'message', message_id: 'message', tenant_id: 'Steven', actor_alias: 'kant', author, deliveries: [],
      }], rowCount: 1,
    }));
    const repository = new CauceRepository({ query } as unknown as DatabasePool);
    const list = await repository.listMessages('Steven', 'kant', 20);
    expect(list.items).toEqual([expect.objectContaining({ author })]);
    const listCall = query.mock.calls.find(([sql]) => sql.includes('AS message_id'));
    expect(listCall?.[0]).toContain(MESSAGE_AUTHOR_SQL);
    expect(listCall?.[0]).toContain('source_member.enabled AND m.tenant_id=$1');
    expect(listCall?.[0]).toContain('edge.enabled AND edge.allow_read');
    const detail = await repository.getMessage('message', 'Pablo', 'midas');
    expect(detail.author).toEqual(author);
    const detailCall = query.mock.calls.find(([sql]) => sql.includes('WHERE m.id=$1'));
    expect(detailCall?.[0]).toContain(MESSAGE_AUTHOR_SQL);
    expect(detailCall?.[0]).toContain('own.enabled AND role.allow_read');
    expect(detailCall?.[0]).toContain('edge.enabled AND edge.allow_read');
  });
});
