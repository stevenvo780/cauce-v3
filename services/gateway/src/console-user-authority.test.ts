import { describe, expect, it } from 'vitest';
import { AuthError } from './auth.js';
import type { ConsoleUser } from './console-users.js';
import { consoleRoleAuthority, consoleUserPrincipal } from './console-user-authority.js';

const user: ConsoleUser = {
  id: '00000000-0000-4000-8000-000000000071', email: 'person@example.test',
  display_name: 'Fixture Person', role: 'operator', tenant_id: 'Fixture', alias: 'fixture-console',
  active: true, password_hash: 'unused', password_changed_at: 0,
};

describe('console user authority', () => {
  it('preserves the password principal attributes and legacy operator scope exactly', () => {
    expect(consoleUserPrincipal(user, 'console:session-fixture', 'console')).toEqual({
      tenant_id: 'Fixture', alias: 'fixture-console', session_id: 'console:session-fixture',
      channel: 'console', roles: ['operator'], permissions: ['route', 'read', 'control', 'notify'],
      operator_id: 'person@example.test',
      operator_profile: { id: 'console:00000000-0000-4000-8000-000000000071', display_name: 'Fixture Person' },
    });
  });

  it('maps reader accounts to the existing read-only ceiling', () => {
    const principal = consoleUserPrincipal({ ...user, role: 'reader' }, 'mcp:session-fixture', 'mcp');
    expect(principal.roles).toEqual([]);
    expect(principal.permissions).toEqual(['read']);
    expect(principal.origin).toBeUndefined();
  });

  it('preserves membership lookup keys without claiming per-person alias isolation', () => {
    const first = consoleUserPrincipal(user, 'mcp:first', 'mcp');
    const second = consoleUserPrincipal({ ...user, id: '00000000-0000-4000-8000-000000000072', email: 'other@example.test' }, 'mcp:second', 'mcp');
    expect([second.tenant_id, second.alias]).toEqual([first.tenant_id, first.alias]);
    expect(second.operator_profile?.id).not.toBe(first.operator_profile?.id);
    expect(second.operator_id).not.toBe(first.operator_id);
  });

  it('rejects inactive users, unknown roles, and invalid membership identities', () => {
    expect(() => consoleUserPrincipal({ ...user, active: false }, 'mcp:fixture', 'mcp')).toThrow(AuthError);
    expect(() => consoleRoleAuthority('owner')).toThrow(AuthError);
    expect(() => consoleUserPrincipal({ ...user, alias: '' }, 'mcp:fixture', 'mcp')).toThrow(AuthError);
  });

  it('does not let a principal mutation change later role mappings', () => {
    const first = consoleUserPrincipal(user, 'mcp:first', 'mcp');
    (first.permissions as string[]).length = 0;
    expect(consoleUserPrincipal(user, 'mcp:second', 'mcp').permissions).toEqual(['route', 'read', 'control', 'notify']);
  });
});
