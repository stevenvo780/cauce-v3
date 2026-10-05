import { describe, expect, it } from 'vitest';
import { ConfigurationRepository } from '../src/configuration.js';
import type { DatabasePool } from '../src/db.js';

function revisionPool(revisions: Record<string, unknown>[]) {
  const queries: string[] = [];
  const query = async (sql: string) => {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    queries.push(normalized);
    if (normalized.includes('role.allow_read')) return { rows: [{ is_hub: false }], rowCount: 1 };
    if (normalized.includes('COALESCE(max(id),0)::text AS revision')) {
      return { rows: [{ revision: '3' }], rowCount: 1 };
    }
    if (normalized.includes('FROM config_revisions')) return { rows: revisions, rowCount: revisions.length };
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

describe('configuration revision read projection', () => {
  it('omits provider account locators without mutating durable rows or other resources', async () => {
    const locator = 'CAUCE_E2E_ACCOUNT_PRIVATE_PATH';
    const stored = [
      {
        id: '3', actor_tenant: 'Steven', actor_alias: 'kant', summary: 'create account',
        operation: {
          resource: 'provider_account', action: 'create', id: 'account-1',
          value: { provider: 'codex', credential_ref: locator, credential_ref_kind: 'env_path' },
        },
      },
      {
        id: '2', actor_tenant: 'Steven', actor_alias: 'kant', summary: 'update tenant',
        operation: {
          resource: 'tenant', action: 'update', id: 'Steven',
          value: { enabled: true, credential_ref: 'unrelated-tenant-metadata' },
        },
      },
    ];
    const originalRows = structuredClone(stored);
    const { pool, queries } = revisionPool(stored);

    const snapshot = await new ConfigurationRepository(pool).get('Steven', 'kant');
    const revisions = snapshot.revisions as Record<string, unknown>[];
    const accountOperation = revisions[0]?.operation as Record<string, unknown>;
    const accountValue = accountOperation.value as Record<string, unknown>;

    expect(accountOperation).toMatchObject({ resource: 'provider_account', action: 'create', id: 'account-1' });
    expect(accountValue).toEqual({ provider: 'codex', credential_ref_kind: 'env_path' });
    expect(JSON.stringify(snapshot)).not.toContain(locator);
    expect(revisions[1]?.operation).toEqual(originalRows[1]?.operation);
    expect(stored).toEqual(originalRows);
    expect(queries.some((sql) => /\b(INSERT|UPDATE|DELETE)\b/iu.test(sql))).toBe(false);
  });
});
