import { describe, expect, it } from 'vitest';
import { ConfigurationRepository } from '../src/configuration.js';
import type { DatabasePool } from '../src/db.js';

interface QueryRecord {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function readerPool(): { pool: DatabasePool; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    queries.push({ sql: normalized, params });
    if (normalized.includes('role.allow_read')) {
      return { rows: [{ is_hub: false }], rowCount: 1 };
    }
    if (normalized.includes('COALESCE(max(id),0)::text AS revision')) {
      return { rows: [{ revision: '0' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = {
    query,
    on: () => client,
    off: () => client,
    release: () => undefined,
  };
  return {
    pool: { query, connect: async () => client } as unknown as DatabasePool,
    queries,
  };
}

describe('configuration reader authority', () => {
  it('uses allow_read, keeps the non-hub scope exact and issues no writes', async () => {
    const { pool, queries } = readerPool();
    const snapshot = await new ConfigurationRepository(pool).get('Pablo', 'midas');

    expect(snapshot).toMatchObject({ revision: 0, tenants: [], rooms: [], memberships: [] });
    const authorization = queries.find((record) => record.sql.includes('FROM memberships membership'));
    expect(authorization?.sql).toContain('role.allow_read');
    expect(authorization?.sql).not.toContain('role.allow_control');
    expect(authorization?.params).toEqual(['Pablo', 'midas']);

    const scopedReads = queries.filter((record) => record.sql.includes('$1::text IS NULL'));
    expect(scopedReads.length).toBeGreaterThan(0);
    expect(scopedReads.every((record) => record.params[0] === 'Pablo')).toBe(true);
    expect(queries.some((record) => /\b(INSERT|UPDATE|DELETE)\b/iu.test(record.sql))).toBe(false);
  });

  it('does not let the same read-only principal enter apply or rollback', async () => {
    const { pool, queries } = readerPool();
    const repository = new ConfigurationRepository(pool);

    await expect(repository.apply('Pablo', 'midas', {
      resource: 'room', action: 'create', tenant_id: 'Pablo', id: 'reader-denied',
      value: { enabled: true },
    }, false, 0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.rollback('Pablo', 'midas', 1, false, 0))
      .rejects.toMatchObject({ code: 'forbidden' });

    const controls = queries.filter((record) => record.sql.includes('role.allow_control'));
    expect(controls).toHaveLength(2);
    expect(queries.some((record) => /\b(INSERT|UPDATE|DELETE)\b/iu.test(record.sql))).toBe(false);
  });
});
