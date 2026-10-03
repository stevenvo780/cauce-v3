import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedOAuthIdentity } from '../../../packages/mcp-fleet-monitor/src/gateway-oauth-identity.js';
import { AuthError } from './auth.js';
import type { ConsoleUser } from './console-users.js';
import { resolveHumanMcpAuthority, type ExternalSubjectResolver } from './human-mcp-authority.js';

const user: ConsoleUser = {
  id: '00000000-0000-4000-8000-000000000081', email: 'account@example.test',
  display_name: 'Fixture Account', role: 'operator', tenant_id: 'Fixture', alias: 'fixture-human',
  active: true, password_hash: 'unused', password_changed_at: 0,
};

function identity(overrides: Partial<VerifiedOAuthIdentity> = {}): VerifiedOAuthIdentity {
  return Object.freeze({
    kind: 'oauth', issuer: 'https://issuer.example.test', subject: 'external-subject',
    audience: 'https://resource.example.test/mcp', expiresAt: Date.now() / 1000 + 600,
    scopes: Object.freeze(['cauce.read', 'cauce.publish']), ...overrides,
  });
}

function fixture() {
  return {
    users: { findById: vi.fn(async (_id: string): Promise<ConsoleUser | undefined> => ({ ...user })) },
    resolver: { resolve: vi.fn<ExternalSubjectResolver['resolve']>(async () => ({ userId: user.id, status: 'active' })) },
  };
}

const signal = (): AbortSignal => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); });

describe('human MCP authority', () => {
  it('returns the agreed shape from an explicit verified-identity binding', async () => {
    const dependencies = fixture();
    const verified = identity();
    const requestSignal = signal();
    const result = await resolveHumanMcpAuthority(dependencies, verified, requestSignal);
    expect(Object.keys(result).sort()).toEqual(['principal', 'scopes', 'userId']);
    expect(dependencies.resolver.resolve).toHaveBeenCalledWith(verified, requestSignal);
    expect(dependencies.users.findById).toHaveBeenCalledWith(user.id);
    expect(result.userId).toBe(user.id);
    expect(result.principal).toMatchObject({
      tenant_id: user.tenant_id, alias: user.alias, channel: 'human-mcp',
      operator_id: user.email, operator_profile: { id: `console:${user.id}`, display_name: user.display_name },
      roles: ['operator'], permissions: ['route', 'read', 'control', 'notify'],
    });
    expect(result.principal.session_id).toMatch(/^human-mcp:[a-f0-9-]+$/u);
    expect(result.principal.origin).toBeUndefined();
    expect(result.scopes).toEqual(['cauce.read', 'cauce.publish']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scopes)).toBe(true);
    expect(Object.isFrozen(result.principal.permissions)).toBe(true);
  });

  it('never infers a mapping from subject, email, profile, tenant, or alias', async () => {
    const dependencies = fixture();
    dependencies.resolver.resolve.mockResolvedValue(undefined);
    const verified = { ...identity({ subject: user.id }), email: user.email, tenant_id: 'Other', alias: 'other', role: 'operator' };
    await expect(resolveHumanMcpAuthority(dependencies, verified, signal())).rejects.toBeInstanceOf(AuthError);
    expect(dependencies.users.findById).not.toHaveBeenCalled();
  });

  it('fails closed with no resolver', async () => {
    const { users } = fixture();
    await expect(resolveHumanMcpAuthority({ users }, identity(), signal())).rejects.toBeInstanceOf(AuthError);
    expect(users.findById).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'revoked'] as const)('rejects a %s binding before reading an account', async (status) => {
    const dependencies = fixture();
    dependencies.resolver.resolve.mockResolvedValue({ userId: user.id, status });
    await expect(resolveHumanMcpAuthority(dependencies, identity(), signal())).rejects.toThrow('human MCP authority is unavailable');
    expect(dependencies.users.findById).not.toHaveBeenCalled();
  });

  it('requires an explicit active status and UUID in the server binding', async () => {
    const dependencies = fixture();
    dependencies.resolver.resolve.mockResolvedValue({ userId: user.email, status: 'active' });
    await expect(resolveHumanMcpAuthority(dependencies, identity(), signal())).rejects.toBeInstanceOf(AuthError);
    dependencies.resolver.resolve.mockResolvedValue({ userId: user.id } as Awaited<ReturnType<ExternalSubjectResolver['resolve']>>);
    await expect(resolveHumanMcpAuthority(dependencies, identity(), signal())).rejects.toBeInstanceOf(AuthError);
    expect(dependencies.users.findById).not.toHaveBeenCalled();
  });

  it.each([undefined, { ...user, active: false }, { ...user, id: '00000000-0000-4000-8000-000000000082' }])(
    'rejects missing, disabled, or mismatched accounts', async (record) => {
      const dependencies = fixture();
      dependencies.users.findById.mockResolvedValue(record);
      await expect(resolveHumanMcpAuthority(dependencies, identity(), signal())).rejects.toBeInstanceOf(AuthError);
    },
  );

  it('re-reads binding, role, membership lookup keys, and profile for each operation', async () => {
    const dependencies = fixture();
    const first = await resolveHumanMcpAuthority(dependencies, identity(), signal());
    dependencies.users.findById.mockResolvedValue({ ...user, role: 'reader', tenant_id: 'Updated', alias: 'updated-human', email: 'renamed@example.test', display_name: 'Renamed' });
    const second = await resolveHumanMcpAuthority(dependencies, identity(), signal());
    expect(second.userId).toBe(first.userId);
    expect(second.principal).toMatchObject({ tenant_id: 'Updated', alias: 'updated-human', operator_id: 'renamed@example.test', roles: [], permissions: ['read'] });
    expect(second.principal.operator_profile).toEqual({ id: `console:${user.id}`, display_name: 'Renamed' });
    expect(second.scopes).toEqual(['cauce.read']);
    expect(second.principal.session_id).not.toBe(first.principal.session_id);
    dependencies.resolver.resolve.mockResolvedValue({ userId: user.id, status: 'revoked' });
    await expect(resolveHumanMcpAuthority(dependencies, identity(), signal())).rejects.toBeInstanceOf(AuthError);
    expect(dependencies.resolver.resolve).toHaveBeenCalledTimes(3);
    expect(dependencies.users.findById).toHaveBeenCalledTimes(2);
  });

  it('intersects verified scopes with the account ceiling without inventing grants', async () => {
    const dependencies = fixture();
    const result = await resolveHumanMcpAuthority(dependencies, identity({ scopes: ['unrelated', 'cauce.read', 'cauce.read'] }), signal());
    expect(result.scopes).toEqual(['cauce.read']);
    expect((await resolveHumanMcpAuthority(dependencies, identity({ scopes: [] }), signal())).scopes).toEqual([]);
  });

  it.each(['resolver', 'users'] as const)('fails closed and sanitizes %s lookup errors', async (source) => {
    const dependencies = fixture();
    if (source === 'resolver') dependencies.resolver.resolve.mockRejectedValue(new Error('private lookup detail'));
    else dependencies.users.findById.mockRejectedValue(new Error('private lookup detail'));
    await expect(resolveHumanMcpAuthority(dependencies, identity(), signal())).rejects.toThrow('human MCP authority is unavailable');
  });

  it('rejects expiration before resolution and after a slow lookup', async () => {
    vi.useFakeTimers();
    const dependencies = fixture();
    await expect(resolveHumanMcpAuthority(dependencies, identity({ expiresAt: Date.now() / 1000 }), signal())).rejects.toBeInstanceOf(AuthError);
    expect(dependencies.resolver.resolve).not.toHaveBeenCalled();
    const verified = identity({ expiresAt: Date.now() / 1000 + 1 });
    dependencies.users.findById.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 2000);
      return user;
    });
    await expect(resolveHumanMcpAuthority(dependencies, verified, signal())).rejects.toBeInstanceOf(AuthError);
  });

  it('does no lookup when already aborted', async () => {
    const dependencies = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(resolveHumanMcpAuthority(dependencies, identity(), controller.signal)).rejects.toBe(controller.signal.reason);
    expect(dependencies.resolver.resolve).not.toHaveBeenCalled();
  });

  it.each(['resolver', 'users'] as const)('cancels promptly during %s lookup even when it ignores the signal', async (source) => {
    const dependencies = fixture();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      if (source === 'resolver') dependencies.resolver.resolve.mockImplementation(async () => {
        resolve();
        await new Promise<void>((done) => { release = done; });
        return { userId: user.id, status: 'active' };
      });
      else dependencies.users.findById.mockImplementation(async () => {
        resolve();
        await new Promise<void>((done) => { release = done; });
        return user;
      });
    });
    const pending = resolveHumanMcpAuthority(dependencies, identity(), controller.signal);
    const result = expect(pending).rejects.toBeDefined();
    await entered;
    controller.abort();
    await result;
    release?.();
    await Promise.resolve();
    if (source === 'resolver') expect(dependencies.users.findById).not.toHaveBeenCalled();
  });
});
