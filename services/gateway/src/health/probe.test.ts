import type { DatabasePool } from '@cauce/store';
import { describe, expect, it, vi } from 'vitest';
import { probeSchemaContract } from './probe.js';

interface RecordedQuery {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

interface RecordingPool {
  readonly pool: DatabasePool;
  readonly statements: readonly RecordedQuery[];
  readonly released: () => number;
}

function recordingPool(rows: readonly Record<string, unknown>[]): RecordingPool {
  const statements: RecordedQuery[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    statements.push({ sql, params });
    return sql.startsWith('CONTRACT') ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 };
  });
  const client = { query, on: vi.fn(), off: vi.fn(), release };
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as DatabasePool,
    statements,
    released: () => release.mock.calls.length,
  };
}

const contractSql = 'CONTRACT SELECT true AS alpha, true AS beta';

describe('probeSchemaContract scaffolding', () => {
  it('opens a read-only transaction with both bounded timeouts before the contract query', async () => {
    const recording = recordingPool([{ alpha: true, beta: true }]);
    await probeSchemaContract(recording.pool, {
      name: 'sample', sql: contractSql, required: ['alpha', 'beta'],
    });
    const order = recording.statements.map((statement) => statement.sql);
    expect(order.slice(0, 5)).toEqual([
      'BEGIN',
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout='1000ms'",
      "SET LOCAL statement_timeout='2000ms'",
      contractSql,
    ]);
    expect(order.at(-1)).toBe('COMMIT');
  });

  it('resolves when every required column is literally true', async () => {
    const recording = recordingPool([{ alpha: true, beta: true, unused: false }]);
    await expect(probeSchemaContract(recording.pool, {
      name: 'sample', sql: contractSql, required: ['alpha', 'beta'],
    })).resolves.toBeUndefined();
    expect(recording.released()).toBe(1);
  });

  it('rejects when a required column is missing from the contract row', async () => {
    const recording = recordingPool([{ alpha: true }]);
    await expect(probeSchemaContract(recording.pool, {
      name: 'sample', sql: contractSql, required: ['alpha', 'beta'],
    })).rejects.toThrow('gateway sample contract is unavailable');
    expect(recording.statements.map((statement) => statement.sql)).toContain('ROLLBACK');
  });

  it('rejects when the contract query returns no row at all', async () => {
    const recording = recordingPool([]);
    await expect(probeSchemaContract(recording.pool, {
      name: 'sample', sql: contractSql, required: ['alpha'],
    })).rejects.toThrow('gateway sample contract is unavailable');
  });

  it.each([['false'], [1], [null], [undefined], ['t']] as const)(
    'rejects PostgreSQL authority arriving as %o instead of a literal true',
    async (value) => {
      const recording = recordingPool([{ alpha: value, beta: true }]);
      await expect(probeSchemaContract(recording.pool, {
        name: 'sample', sql: contractSql, required: ['alpha', 'beta'],
      })).rejects.toThrow('gateway sample contract is unavailable');
    },
  );

  it('passes bound parameters through with the contract query', async () => {
    const recording = recordingPool([{ alpha: true }]);
    await probeSchemaContract(recording.pool, {
      name: 'sample', sql: contractSql, required: ['alpha'], params: ['sha', 'body'],
    });
    const contract = recording.statements.find((statement) => statement.sql === contractSql);
    expect(contract?.params).toEqual(['sha', 'body']);
  });

  it('runs the after hook inside the same transaction, after the contract query', async () => {
    const recording = recordingPool([{ alpha: true }]);
    await probeSchemaContract(recording.pool, {
      name: 'sample',
      sql: contractSql,
      required: ['alpha'],
      after: async (client) => {
        await client.query('SECOND QUERY');
      },
    });
    const order = recording.statements.map((statement) => statement.sql);
    expect(order.indexOf('SECOND QUERY')).toBeGreaterThan(order.indexOf(contractSql));
    expect(order.indexOf('SECOND QUERY')).toBeLessThan(order.indexOf('COMMIT'));
  });

  it('never runs the after hook when the contract row is rejected', async () => {
    const recording = recordingPool([{ alpha: false }]);
    const after = vi.fn(async () => undefined);
    await expect(probeSchemaContract(recording.pool, {
      name: 'sample', sql: contractSql, required: ['alpha'], after,
    })).rejects.toThrow('gateway sample contract is unavailable');
    expect(after).not.toHaveBeenCalled();
  });

  it('propagates an after-hook failure and rolls the transaction back', async () => {
    const recording = recordingPool([{ alpha: true }]);
    await expect(probeSchemaContract(recording.pool, {
      name: 'sample',
      sql: contractSql,
      required: ['alpha'],
      after: async () => {
        throw new Error('gateway sample behavior is unavailable');
      },
    })).rejects.toThrow('gateway sample behavior is unavailable');
    expect(recording.statements.map((statement) => statement.sql)).toContain('ROLLBACK');
  });
});
