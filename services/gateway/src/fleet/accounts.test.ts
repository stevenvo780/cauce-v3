import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@cauce/store';
import { readFleetProviderAccounts, scopedFleetProviderAgents } from './accounts.js';

describe('trusted provider account projection', () => {
  it('scopes accounts to affected identities and preserves both sides of an account replacement', () => {
    const request = { kind: 'update' as const, target: { resource: 'agent' as const, tenant_id: 'Steven', alias: 'one' },
      expected_revision: 1, idempotency_key: 'scoped-one', parameters: { runtime_key: 'one', harness_id: 'codex', primary_account_id: 'new',
        primary_room_id: 'room', memberships: [{ room_id: 'room', role: 'agent' }],
        placement: { host_id: 'isolated', mode: 'native' as const, runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/state/one' } } };
    const prior = { tenant_id: 'Steven', alias: 'one', primary_account_id: 'old' };
    const desired = { ...prior, primary_account_id: 'new' };
    const unrelated = { tenant_id: 'Elsewhere', alias: 'one', primary_account_id: 'unrelated-grok' };
    expect(scopedFleetProviderAgents(request, [], [prior], [desired, unrelated])).toEqual([
      prior, desired, { primary_account_id: 'new' },
    ]);
    const group = { kind: 'retire' as const, target: { resource: 'room' as const, tenant_id: 'Steven', room_id: 'room' },
      expected_revision: 1, idempotency_key: 'scoped-group', parameters: {} };
    expect(scopedFleetProviderAgents(group, [{ tenant_id: 'Steven', alias: 'one' }], [prior], [desired, unrelated])).toEqual([prior, desired]);
  });
  it('reads identities from a locked database scope and removes unrelated private fields', async () => {
    const account = { id: 'approved', provider: 'codex', external_account_id: 'fixture@example.invalid',
      payer_tenant_id: 'Steven', shared_with_pool: false, enabled: true };
    const query = async (sql: string, params: unknown[]) => {
      expect(sql).toContain('FOR SHARE'); expect(sql).not.toContain('secret_locator');
      expect(params).toEqual([['approved']]); return { rows: [account] };
    };
    expect(await readFleetProviderAccounts({ query } as unknown as DatabaseClient,
      [{ primary_account_id: 'approved', identity: 'spoofed@example.invalid' }, { primary_account_id: 'approved' }])).toEqual([account]);
  });
  it('rejects missing, malformed or excessive scopes instead of trusting request identities', async () => {
    const client = { query: async () => ({ rows: [] }) } as unknown as DatabaseClient;
    await expect(readFleetProviderAccounts(client, [{ primary_account_id: 'missing' }])).rejects.toThrow('unavailable');
    await expect(readFleetProviderAccounts(client, [{ primary_account_id: '../account' }])).rejects.toThrow('invalid');
    await expect(readFleetProviderAccounts(client, Array.from({ length: 1001 }, (_, index) => ({ primary_account_id: `account${String(index)}` })))).rejects.toThrow('invalid');
    expect(await readFleetProviderAccounts(client, [{ primary_account_id: null }])).toEqual([]);
  });
});
