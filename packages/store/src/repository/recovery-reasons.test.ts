import { schemaBarrierReply } from '../../../../tests/helpers/schema-barrier.js';
import { describe, expect, it, vi } from 'vitest';
import { publishRequestHash, type PublishMessage } from '@cauce/protocol';
import { CauceRepository, StoreError, type DatabasePool } from '../index.js';
import { CONTEXT_WRITE_QUARANTINE_KIND } from './agent-context-quarantine.js';

function repositoryFor(rowsFor: (sql: string) => Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    const schema = schemaBarrierReply(sql, params);
    if (schema) return schema;
    const rows = rowsFor(sql);
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release, on: vi.fn(), off: vi.fn() }) } as unknown as DatabasePool;
  return { repository: new CauceRepository(pool), query, release };
}

function isContextAdmissionQuery(sql: string): boolean {
  return sql.startsWith('SET LOCAL lock_timeout=')
    || sql.startsWith('SELECT pg_advisory_xact_lock_shared(')
    || sql.includes('SELECT id,payload,status,claim_token::text,lease_until FROM jobs WHERE tenant_id=$1 AND kind=$2');
}

describe('store recovery reasons', () => {
  it('preserves legacy StoreError construction without inferring authority from prose', () => {
    const error = new StoreError('conflict', 'idempotency key reused with a different request');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'StoreError', code: 'conflict', message: 'idempotency key reused with a different request' });
    expect(error.recoveryReason).toBeUndefined();
  });

  it.each([
    { capacity: [], code: 'conflict', reason: 'consumer_capacity_missing',
      message: 'delivery consumer is missing its durable agent capacity' },
    { capacity: [{ cap: 0, enabled: true }], code: 'conflict', reason: 'consumer_capacity_invalid',
      message: 'delivery consumer capacity is invalid' },
    { capacity: [{ cap: 1, enabled: false }], code: 'forbidden', reason: 'consumer_disabled',
      message: 'delivery consumer is disabled' },
  ])('marks lease admission with $reason without changing its public error', async (expected) => {
    const { repository, query, release } = repositoryFor((sql) => {
      if (sql.includes('SELECT policy.allow_route')) return [{ allow_route: true }];
      if (sql.includes('SELECT max_concurrent_deliveries AS cap')) return expected.capacity;
      if (isContextAdmissionQuery(sql)) return [];
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return [];
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(repository.acquireLease('Steven', 'kant', 'test', [], 60_000, {
      requireDeclaredCapacity: true, requireEnabledAgent: true,
    })).rejects.toMatchObject({
      code: expected.code, message: expected.message, recoveryReason: expected.reason,
    });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
    const admission = query.mock.calls.find(([sql]) => sql.includes('FROM jobs WHERE tenant_id=$1 AND kind=$2'));
    expect(admission?.[1]).toEqual(['Steven', CONTEXT_WRITE_QUARANTINE_KIND]);
  });

  it.each([
    { name: 'missing declaration', configured: [], usage: [{ in_flight: '0', human_in_flight: '0' }],
      reason: 'consumer_capacity_missing', message: 'delivery consumer is missing its durable agent capacity' },
    { name: 'invalid configured limit', configured: [{ cap: 0 }], usage: [{ in_flight: '0', human_in_flight: '0' }],
      reason: 'consumer_capacity_invalid', message: 'delivery consumer capacity is invalid' },
    { name: 'inconsistent live counts', configured: [{ cap: 2 }], usage: [{ in_flight: '1', human_in_flight: '2' }],
      reason: 'consumer_capacity_invalid', message: 'delivery consumer capacity is invalid' },
    { name: 'unavailable usage', configured: [{ cap: 2 }], usage: [],
      reason: undefined, message: 'delivery consumer capacity could not be evaluated' },
  ])('marks delivery claim admission without inferring a reason: $name', async (expected) => {
    const { repository, query, release } = repositoryFor((sql) => {
      if (sql.includes('SELECT policy.allow_route')) return [{ allow_route: true }];
      if (sql.includes('SELECT capabilities FROM connection_leases')) return [{ capabilities: [] }];
      if (sql.includes('SELECT interactive_streak')) return [{ interactive_streak: 0 }];
      if (sql.includes('SELECT max_concurrent_deliveries AS cap')) return expected.configured;
      if (sql.includes('SELECT 1 FROM connection_leases')) return [{ live: true }];
      if (sql.includes(' AS human_in_flight')) return expected.usage;
      if (isContextAdmissionQuery(sql)) return [];
      if (sql.startsWith('SET LOCAL') || sql.startsWith('SELECT pg_advisory_xact_lock_shared')
          || sql.includes('INSERT INTO delivery_lane_fairness') || sql === 'BEGIN' || sql === 'ROLLBACK') return [];
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(repository.claimDeliveries('Steven', 'kant', 'test', 1, 20, 30_000, 3, {
      requireDeclaredCapacity: true,
    })).rejects.toMatchObject({
      code: 'conflict', message: expected.message, recoveryReason: expected.reason,
    });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
    const admission = query.mock.calls.find(([sql]) => sql.includes('FROM jobs WHERE tenant_id=$1 AND kind=$2'));
    expect(admission?.[1]).toEqual(['Steven', CONTEXT_WRITE_QUARANTINE_KIND]);
  });

  const command: PublishMessage = {
    version: '3.0', request_id: '00000000-0000-4000-8000-000000000001', trace_id: 'test-recovery',
    tenant_id: 'Steven', actor_alias: 'kant', room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'kant' }], body: { text: 'transcription retry' },
    idempotency_key: 'telegram:900001:42', lane: 'interactive', priority: 0,
  };
  const durable = { request_hash: 'original-transcription-hash', message_id: 'durable-message', response: {} };

  it.each([
    { name: 'durable body mismatch', prior: durable, reason: 'idempotency_durable_conflict' },
    { name: 'missing idempotency row', prior: undefined, reason: undefined },
    { name: 'missing durable message', prior: { ...durable, message_id: null }, reason: undefined },
    { name: 'missing durable receipt', prior: { ...durable, response: null }, reason: undefined },
    { name: 'in-progress matching request', prior: {
      ...durable, request_hash: publishRequestHash(command), message_id: null,
    }, reason: undefined },
  ])('grants durable recovery only to an existing committed publication: $name', async ({ prior, reason }) => {
    const { repository, query, release } = repositoryFor((sql) => {
      if (sql.startsWith('SELECT 1 FROM memberships')) return [{ allowed: true }];
      if (sql.includes('SELECT request_hash,response,message_id FROM idempotency_keys')) {
        return prior === undefined ? [] : [prior];
      }
      if (sql.includes('INSERT INTO idempotency_keys') || sql === 'BEGIN' || sql === 'ROLLBACK') return [];
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(repository.publish(command)).rejects.toMatchObject({ code: 'conflict', recoveryReason: reason });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
