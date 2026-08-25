import { describe, expect, it } from 'vitest';
import type { ConfigMutation } from '@cauce/protocol';
import { ConfigurationError, ConfigurationRepository } from '../src/configuration.js';
import type { DatabasePool } from '../src/db.js';

interface PreparedResponse {
  readonly includes: string;
  readonly rows: Record<string, unknown>[];
}

interface QueryRecord {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakePool(responses: readonly PreparedResponse[] = []): {
  pool: DatabasePool;
  queries: QueryRecord[];
} {
  const queries: QueryRecord[] = [];
  const client = {
    on: () => undefined,
    off: () => undefined,
    async query(sql: string, params: readonly unknown[] = []) {
      queries.push({ sql, params });
      const normalized = sql.replace(/\s+/gu, ' ');
      const response = responses.find((candidate) => normalized.includes(candidate.includes));
      return { rows: response?.rows ?? [], rowCount: response?.rows.length ?? 0 };
    },
    release: () => undefined,
  };
  return {
    pool: {
      connect: async () => client,
      query: (sql: string, params?: readonly unknown[]) => client.query(sql, params),
    } as unknown as DatabasePool,
    queries,
  };
}

const unsupportedProfileMutation = {
  resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'zeus',
  value: { purpose: 'no debe llegar a la base' },
} as unknown as ConfigMutation;

const unsupportedRoleProjectionMutation = {
  resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'zeus',
  value: { role_brief: 'no debe llegar a la base' },
} as unknown as ConfigMutation;

describe('perfil canónico: el editor genérico falla cerrado', () => {
  it.each([
    ['agent_profile', unsupportedProfileMutation],
    ['agents.role_brief', unsupportedRoleProjectionMutation],
  ])('rechaza %s antes de abrir una transacción', async (_name, mutation) => {
    const { pool, queries } = fakePool();
    const error = await new ConfigurationRepository(pool)
      .apply('Steven', 'kant', mutation, false, 0)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(queries).toEqual([]);
  });

  it('un dry-run tampoco puede fingir que el runtime aplicaría el perfil', async () => {
    const { pool, queries } = fakePool();
    await expect(new ConfigurationRepository(pool).apply(
      'Steven', 'kant', unsupportedProfileMutation, true, 0,
    )).rejects.toMatchObject({ code: 'invalid_input' });
    expect(queries).toEqual([]);
  });

  it('un rollback histórico no revive la vía duplicada ni escribe una revisión falsa', async () => {
    const { pool, queries } = fakePool([
      { includes: 'SELECT tenant.is_hub FROM memberships', rows: [{ is_hub: true }] },
      { includes: 'COALESCE(max(id),0)::text AS revision', rows: [{ revision: '12' }] },
      {
        includes: 'FROM config_revisions WHERE id=$1 FOR UPDATE',
        rows: [{
          id: '7', actor_tenant: 'Steven', actor_alias: 'kant',
          operation: { resource: 'agent_profile', action: 'update' },
          inverse_operation: unsupportedProfileMutation,
          summary: 'legacy profile edit', rolled_back_revision_id: null,
          created_at: new Date('2026-08-25T00:00:00Z'),
        }],
      },
    ]);

    await expect(new ConfigurationRepository(pool).rollback(
      'Steven', 'kant', 7, false, 12,
    )).rejects.toMatchObject({ code: 'invalid_input' });
    const sql = queries.map((query) => query.sql.replace(/\s+/gu, ' '));
    expect(sql.some((statement) => statement.includes('INSERT INTO config_revisions'))).toBe(false);
    expect(sql.some((statement) => statement.includes('INSERT INTO agent_profiles'))).toBe(false);
    expect(sql.some((statement) => statement.includes('UPDATE agent_profiles'))).toBe(false);
  });

  it('no borra un agente si el cascade perdería su perfil canónico', async () => {
    const { pool, queries } = fakePool([
      { includes: 'SELECT tenant.is_hub FROM memberships', rows: [{ is_hub: true }] },
      { includes: 'COALESCE(max(id),0)::text AS revision', rows: [{ revision: '3' }] },
      {
        includes: 'FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE',
        rows: [{
          harness_id: 'codex', display_name: 'Zeus', enabled: false,
          container_name: 'ws-zeus', runtime_user: 'dev', home_directory: '/home/dev',
          state_directory: '/var/lib/zeus', role_brief: null, max_concurrent_deliveries: 2,
        }],
      },
      { includes: 'FROM agent_profiles WHERE tenant_id=$1 AND alias=$2 LIMIT 1', rows: [{ present: 1 }] },
    ]);

    await expect(new ConfigurationRepository(pool).apply('Steven', 'kant', {
      resource: 'agent', action: 'delete', tenant_id: 'Steven', alias: 'zeus',
    }, false, 3)).rejects.toMatchObject({ code: 'conflict' });
    expect(queries.some((query) => /DELETE FROM agents/iu.test(query.sql))).toBe(false);
  });
});
