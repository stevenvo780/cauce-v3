import { describe, expect, it } from 'vitest';
import { pool, registerEgressSuite } from '../../../packages/store/test/egress-notification-postgres-helpers.js';
import { hashPassword } from './password.js';
import { maintainConsoleUser, type ConsoleUserMaintenance } from './console-user-maintenance.js';

registerEgressSuite(import.meta.url);
const options: ConsoleUserMaintenance = {
  email: 'operator@company.example', name: undefined, role: undefined,
  tenant: undefined, alias: undefined, updateOnly: false, activate: false,
};

describe('generic console account durable scope', () => {
  it('creates an explicitly scoped company account and preserves that scope during password maintenance', async () => {
    await pool.query("INSERT INTO tenants(id) VALUES('CompanyC'); INSERT INTO agents(tenant_id,alias) VALUES('CompanyC','owner')");
    const hashOptions = { cost: 1024, blockSize: 8, parallelism: 1 };
    const initialHash = await hashPassword('fixture-initial-password', hashOptions);
    const changedHash = await hashPassword('fixture-changed-password', hashOptions);
    const resetHash = await hashPassword('fixture-reset-password', hashOptions);
    const created = await maintainConsoleUser(pool, { ...options, tenant: 'CompanyC', alias: 'owner' }, initialHash);
    expect(created).toMatchObject({ tenant_id: 'CompanyC', alias: 'owner', role: 'operator', active: true });
    const changed = await maintainConsoleUser(pool, options, changedHash);
    expect(changed).toEqual(created);
    const reset = await maintainConsoleUser(pool, { ...options, updateOnly: true }, resetHash);
    expect(reset).toEqual(created);
    expect((await pool.query('SELECT tenant_id,actor_alias FROM human_tenant_memberships WHERE human_id=$1', [created.id])).rows)
      .toEqual([{ tenant_id: 'CompanyC', actor_alias: 'owner' }]);
    expect((await pool.query('SELECT password_hash FROM console_users WHERE id=$1', [created.id])).rows)
      .toEqual([{ password_hash: resetHash }]);
  });

  it.each([{ tenant: undefined, alias: undefined }, { tenant: 'CompanyC', alias: undefined }, { tenant: undefined, alias: 'owner' }])(
    'rejects a new account without complete identity before an insert: %j', async (scope) => {
      await expect(maintainConsoleUser(pool, { ...options, ...scope }, 'fixture-hash')).rejects.toThrow('tenant y alias explícitos');
      expect((await pool.query('SELECT id FROM console_users')).rows).toHaveLength(0);
      expect((await pool.query('SELECT human_id FROM human_tenant_memberships')).rows).toHaveLength(0);
    },
  );
});
