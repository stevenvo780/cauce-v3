import { schemaBarrierReply } from '../../../../../tests/helpers/schema-barrier.js';
import { describe, expect, it, vi } from 'vitest';
import { buildPublishReceipt, consolePublishIntentSemanticHash, publishRequestHash, type PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool, type PublishOptions } from '../../index.js';
import { consolePublishConversationHash } from '../config.js';

const scope = 'a'.repeat(64);
const command: PublishMessage = {
  version: '3.0', request_id: '10000000-0000-4000-8000-000000000001', trace_id: 'trace-author',
  tenant_id: 'Steven', actor_alias: 'kant', room_id: 'grp.steven',
  recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }], body: { text: 'Ping' },
  idempotency_key: 'console:prepared', lane: 'interactive', priority: 50,
  authenticated_context: { session_id: 'session', channel: 'console' },
};
const author = { kind: 'human' as const, subject_id: `human:${'b'.repeat(64)}`, display_name: 'Steven' };
const options: PublishOptions = { requirePreparedConsoleIntent: true, consoleIntentOperatorScope: scope, consoleAuthor: author };
const messageId = '20000000-0000-4000-8000-000000000001';
const deliveryId = '30000000-0000-4000-8000-000000000001';

vi.mock('../config.js', async (original) => ({
  ...await original<object>(),
  assertPublishRoute: vi.fn(async () => undefined),
  lockConsolePublishIntents: vi.fn(async () => undefined),
  loadConsolePublishIntentByKey: vi.fn(async () => ({ prepared: {
    idempotency_key: command.idempotency_key, operator_scope_hash: scope,
    semantic_hash: consolePublishIntentSemanticHash(command), conversation_hash: consolePublishConversationHash(command),
  }, confirmed: {} })),
  expireStaleConsolePublishIntent: vi.fn(async (_client: unknown, _tenant: unknown, _actor: unknown, state: unknown) => state),
}));

function fixture(duplicate = false, failAudit = false) {
  const receipt = buildPublishReceipt(command, { message_id: messageId, delivery_ids: [deliveryId], duplicate: false,
    request_id: command.request_id, trace_id: command.trace_id });
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const schema = schemaBarrierReply(sql, values);
    if (schema) return schema;
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('INSERT INTO idempotency_keys')) rows = duplicate ? [] : [{ idempotency_key: command.idempotency_key }];
    else if (sql.includes('INSERT INTO messages')) rows = [{ id: messageId }];
    else if (sql.includes('INSERT INTO deliveries')) rows = [{ id: deliveryId }];
    else if (sql.includes('SELECT request_hash,response,message_id FROM idempotency_keys')) rows = [{
      request_hash: publishRequestHash(command), response: receipt, message_id: messageId,
    }];
    else if (sql.includes('FROM messages WHERE id=$1 FOR SHARE')) rows = [{
      ...command, id: messageId, origin: null, auth_session_id: 'session', auth_channel: 'console',
    }];
    else if (sql.includes('FROM deliveries WHERE message_id=$1 FOR SHARE')) rows = [{ id: deliveryId, recipient_tenant: 'Steven', recipient_alias: 'jarvis' }];
    else if (sql.includes('INSERT INTO audit_events')) {
      if (failAudit) throw new Error('audit unavailable');
      expect(values?.slice(0, 5)).toEqual(['Steven', 'kant', command.request_id, messageId, command.trace_id]);
    } else if (!['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) && !sql.includes('INSERT INTO adapter_outbox')
        && !sql.includes('SELECT pg_notify') && !sql.includes('UPDATE idempotency_keys')) throw new Error(`unexpected query: ${sql}`);
    return { rows, rowCount: rows.length };
  });
  const pool = { connect: async () => ({ query, release: vi.fn(), on: vi.fn(), off: vi.fn() }) } as unknown as DatabasePool;
  return { repository: new CauceRepository(pool), query, receipt };
}

describe('publish human provenance transaction', () => {
  it('writes exactly one author snapshot in the same transaction as message, deliveries and receipt', async () => {
    const { repository, query, receipt } = fixture();
    expect(await repository.publish(command, options)).toEqual(receipt);
    const audit = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit_events'));
    expect(audit).toHaveLength(1);
    expect(JSON.parse(String(audit[0]?.[1]?.[5]))).toMatchObject({ console_author: author, authenticated_session_id: 'session', authenticated_channel: 'console' });
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('never overwrites a historical author on an idempotent retry, even after a profile rename', async () => {
    const { repository, query, receipt } = fixture(true);
    expect(await repository.publish(command, { ...options, consoleAuthor: { ...author, display_name: 'Renamed' } }))
      .toEqual({ ...receipt, duplicate: true });
    expect(query.mock.calls.some(([sql]) => /(?:INSERT INTO|UPDATE) audit_events/u.test(sql))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('rejects another operator scope before a durable write', async () => {
    const { repository, query } = fixture();
    await expect(repository.publish(command, { ...options, consoleIntentOperatorScope: 'c'.repeat(64) }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('rolls back if the author audit cannot be persisted', async () => {
    const { repository, query } = fixture(false, true);
    await expect(repository.publish(command, options)).rejects.toThrow('audit unavailable');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });
});
