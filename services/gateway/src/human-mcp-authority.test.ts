import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockHumanIdentity, StoreError, type DatabaseClient, type HumanIdentitySnapshot } from '@cauce/store';
import type { VerifiedOAuthIdentity } from '../../../packages/mcp-fleet-monitor/src/gateway-oauth-identity.js';
import { AuthError } from './auth.js';
import type { ConsoleUser } from './console-users.js';
import { createHumanPublishAuthority, createHumanReadAuthority, resolveHumanMcpAuthority, type ExternalSubjectResolver, type HumanIdentityStore } from './human-mcp-authority.js';

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

function snapshot(): HumanIdentitySnapshot {
  return {
    humanId: user.id, bindingId: '00000000-0000-4000-8000-000000000091', bindingRevision: '9007199254740993',
    provider: 'oauth', namespace: identity().issuer, subject: identity().subject,
    account: { active: true, role: 'operator', defaultTenant: 'Steven', displayName: user.display_name },
    membership: { tenantId: 'Steven', actorAlias: 'member-human', role: 'operator',
      permissions: ['read', 'route', 'control', 'notify'], enabled: true, revision: '9007199254740994' },
  };
}

function durableFixture() {
  const record = snapshot();
  const identityStore = {
    resolve: vi.fn<HumanIdentityStore['resolve']>(async () => record),
    lock: vi.fn<HumanIdentityStore['lock']>(async () => record),
  };
  const query = vi.fn(async () => ({ rows: [] }));
  const client = { query } as unknown as DatabaseClient;
  const pinned = { humanId: record.humanId, tenantId: 'Steven' as const, actorAlias: record.membership.actorAlias };
  return { record, identityStore, client, pinned, query };
}

describe('durable human MCP authority', () => {
  it('uses only the exact external key and safe membership-derived identity', async () => {
    const f = durableFixture();
    const requestSignal = signal();
    const result = await resolveHumanMcpAuthority(f, identity(), requestSignal);
    expect(f.identityStore.resolve).toHaveBeenCalledWith({ provider: 'oauth', namespace: identity().issuer,
      subject: identity().subject }, expect.any(AbortSignal));
    expect(result).toMatchObject({ userId: user.id, scopes: ['cauce.read', 'cauce.publish'], principal: {
      tenant_id: 'Steven', alias: 'member-human', operator_id: `console:${user.id}`,
      operator_profile: { id: `console:${user.id}` }, permissions: ['route', 'read'],
    } });
    expect(JSON.stringify(result)).not.toContain(user.email);
    expect(f.identityStore.resolve.mock.calls[0]?.[1].aborted).toBe(false);
  });

  it('propagates request cancellation into the durable SQL resolver signal', async () => {
    const f = durableFixture();
    const controller = new AbortController();
    const reason = new Error('cancel lookup');
    f.identityStore.resolve.mockImplementation(async (_key, lookupSignal) => {
      controller.abort(reason);
      lookupSignal.throwIfAborted();
      return f.record;
    });
    await expect(resolveHumanMcpAuthority(f, identity(), controller.signal)).rejects.toBe(reason);
  });

  it('bounds the SQL resolver signal by the verified OAuth expiry', async () => {
    const f = durableFixture();
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    await resolveHumanMcpAuthority(f, identity({ expiresAt: Date.now() / 1000 + 1 }), signal());
    expect(deadline.mock.calls[0]?.[0]).toBeGreaterThan(0);
    expect(deadline.mock.calls[0]?.[0]).toBeLessThanOrEqual(1000);
    deadline.mockRestore();
  });

  it.each(['account', 'membership'] as const)('applies the %s reader ceiling using the shared role map', async (source) => {
    const f = durableFixture();
    f.identityStore.resolve.mockResolvedValue({ ...f.record, [source]: { ...f.record[source], role: 'reader' } });
    const result = await resolveHumanMcpAuthority(f, identity(), signal());
    expect(result.principal.roles).toEqual([]);
    expect(result.principal.permissions).toEqual(['read']);
    expect(result.scopes).toEqual(['cauce.read']);
  });

  it('intersects membership permissions and verified scopes', async () => {
    const f = durableFixture();
    f.identityStore.resolve.mockResolvedValue({ ...f.record, membership: { ...f.record.membership, permissions: ['route'] } });
    expect((await resolveHumanMcpAuthority(f, identity(), signal())).scopes).toEqual(['cauce.publish']);
    expect((await resolveHumanMcpAuthority(f, identity({ scopes: ['cauce.read'] }), signal())).principal.permissions).toEqual([]);
  });

  it.each(['missing', 'error'] as const)('never falls back to legacy when durable lookup is %s', async (mode) => {
    const f = durableFixture();
    const legacy = fixture();
    if (mode === 'missing') f.identityStore.resolve.mockResolvedValue(undefined);
    else f.identityStore.resolve.mockRejectedValue(new Error('private SQL detail'));
    await expect(resolveHumanMcpAuthority({ ...f, ...legacy }, identity(), signal())).rejects.toBeInstanceOf(AuthError);
    expect(legacy.resolver.resolve).not.toHaveBeenCalled();
    expect(legacy.users.findById).not.toHaveBeenCalled();
  });

  it('locks on the caller client and returns only fresh server-derived provenance', async () => {
    const f = durableFixture();
    const authorize = createHumanPublishAuthority(identity(), f.pinned, signal(), f.identityStore);
    const result = await authorize(f.client);
    expect(f.identityStore.lock).toHaveBeenCalledWith(f.client,
      { provider: 'oauth', namespace: identity().issuer, subject: identity().subject }, user.id);
    expect(f.identityStore.resolve).not.toHaveBeenCalled();
    expect(result).toEqual({ ...f.pinned, clientProvenance: { kind: 'unknown' } });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(['humanId', 'tenantId', 'actorAlias'] as const)('rejects a changed %s between phases', async (field) => {
    const f = durableFixture();
    const changed = field === 'humanId' ? { ...f.record, humanId: '00000000-0000-4000-8000-000000000082' }
      : field === 'tenantId' ? { ...f.record, account: { ...f.record.account, defaultTenant: 'Jhon' },
        membership: { ...f.record.membership, tenantId: 'Jhon' } }
        : { ...f.record, membership: { ...f.record.membership, actorAlias: 'changed-alias' } };
    f.identityStore.lock.mockResolvedValue(changed);
    await expect(createHumanPublishAuthority(identity(), f.pinned, signal(), f.identityStore)(f.client))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects fresh role or permission revocation without trusting the prepare snapshot', async () => {
    const f = durableFixture();
    const authorize = createHumanPublishAuthority(identity(), f.pinned, signal(), f.identityStore);
    await expect(authorize(f.client)).resolves.toEqual({ ...f.pinned, clientProvenance: { kind: 'unknown' } });
    f.identityStore.lock.mockResolvedValue({ ...f.record, account: { ...f.record.account, role: 'reader' } });
    await expect(authorize(f.client)).rejects.toMatchObject({ code: 'forbidden' });
    f.identityStore.lock.mockResolvedValue({ ...f.record, membership: { ...f.record.membership, permissions: ['read'] } });
    await expect(authorize(f.client)).rejects.toMatchObject({ code: 'forbidden' });
    f.identityStore.lock.mockRejectedValue(new StoreError('forbidden', 'human identity is unavailable'));
    await expect(authorize(f.client)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('pins a copy of verified claims and identity before later caller mutation', async () => {
    const f = durableFixture();
    const verified = { ...identity(), scopes: ['cauce.read', 'cauce.publish'] };
    const authorize = createHumanPublishAuthority(verified, f.pinned, signal(), f.identityStore);
    verified.subject = 'changed';
    verified.scopes.length = 0;
    f.pinned.actorAlias = 'changed';
    expect(await authorize(f.client)).toEqual({ humanId: user.id, tenantId: 'Steven', actorAlias: 'member-human',
      clientProvenance: { kind: 'unknown' } });
  });

  it('checks expiry and abort again after acquiring locks', async () => {
    vi.useFakeTimers();
    const f = durableFixture();
    const verified = identity({ expiresAt: Date.now() / 1000 + 1 });
    f.identityStore.lock.mockImplementation(async () => { vi.setSystemTime(Date.now() + 2000); return f.record; });
    await expect(createHumanPublishAuthority(verified, f.pinned, signal(), f.identityStore)(f.client)).rejects.toBeInstanceOf(AuthError);
    const controller = new AbortController();
    const aborted = new Error('request cancelled');
    f.identityStore.lock.mockImplementation(async () => { controller.abort(aborted); return f.record; });
    await expect(createHumanPublishAuthority(identity(), f.pinned, controller.signal, f.identityStore)(f.client))
      .rejects.toBe(aborted);
  });

  it('rejects an already aborted or expired request before SQL', async () => {
    const f = durableFixture();
    const controller = new AbortController(); controller.abort();
    await expect(createHumanPublishAuthority(identity(), f.pinned, controller.signal, f.identityStore)(f.client)).rejects.toBeDefined();
    await expect(createHumanPublishAuthority(identity({ expiresAt: 0 }), f.pinned, signal(), f.identityStore)(f.client)).rejects.toBeInstanceOf(AuthError);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.identityStore.lock).not.toHaveBeenCalled();
  });
});

function lockedRows() {
  const record = snapshot();
  return [
    [{ human_id: record.humanId }],
    [{ id: record.humanId, active: true, role: 'operator', tenant_id: 'Steven', display_name: 'Fixture' }],
    [{ id: record.bindingId, human_id: record.humanId, enabled: true, revoked_at: null, revision: record.bindingRevision }],
    [{ tenant_id: 'Steven', actor_alias: 'member-human', role: 'operator', permissions: ['read', 'route'],
      enabled: true, revoked_at: null, revision: record.membership.revision }],
  ];
}

describe('human identity locking query contract', () => {
  it('locks account then exact binding then default membership on the supplied client', async () => {
    const rows = lockedRows();
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: rows.shift() ?? [] }));
    const client = { query } as unknown as DatabaseClient;
    const key = { provider: 'oauth' as const, namespace: ' HTTPS://Issuer.test/ ', subject: ' Subject ' };
    const result = await lockHumanIdentity(client, key, user.id);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringMatching(/^SELECT human_id FROM human_external_identities/),
      expect.stringMatching(/FROM console_users WHERE id=\$1 FOR SHARE$/),
      expect.stringMatching(/FROM human_external_identities[\s\S]+FOR SHARE$/),
      expect.stringMatching(/FROM human_tenant_memberships WHERE human_id=\$1 AND tenant_id=\$2 FOR SHARE$/),
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual(['oauth', key.namespace, key.subject]);
    expect(query.mock.calls[2]?.[1]).toEqual(['oauth', key.namespace, key.subject]);
    expect(query.mock.calls[0]?.[0]).toContain('namespace=$2 COLLATE "C" AND subject=$3 COLLATE "C"');
    expect(query.mock.calls[3]?.[1]).toEqual([user.id, 'Steven']);
    expect(result).toMatchObject({ ...key, humanId: user.id, bindingRevision: '9007199254740993' });
    expect(query.mock.calls.every(([sql]) => !/email|password|token|SELECT \*/i.test(sql))).toBe(true);
  });

  it('revalidates the binding UUID after locking the preliminary account', async () => {
    const rows = lockedRows();
    rows[2] = [{ ...rows[2]?.[0], human_id: '00000000-0000-4000-8000-000000000082' }];
    const query = vi.fn(async () => ({ rows: rows.shift() ?? [] }));
    await expect(lockHumanIdentity({ query } as unknown as DatabaseClient,
      { provider: 'oauth', namespace: 'issuer', subject: 'subject' }, user.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('rejects a missing default membership without selecting an alternative', async () => {
    const rows = lockedRows(); rows[3] = [];
    const query = vi.fn(async () => ({ rows: rows.shift() ?? [] }));
    await expect(lockHumanIdentity({ query } as unknown as DatabaseClient,
      { provider: 'oauth', namespace: 'issuer', subject: 'subject' }, user.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(query).toHaveBeenCalledTimes(4);
  });
});

describe('durable human read authority', () => {
  it.each(['account', 'membership', 'both'] as const)('accepts a %s reader without operator or route authority', async (source) => {
    const f = durableFixture();
    f.identityStore.lock.mockResolvedValue({ ...f.record,
      account: { ...f.record.account, role: source === 'membership' ? 'operator' : 'reader' },
      membership: { ...f.record.membership, role: source === 'account' ? 'operator' : 'reader', permissions: ['read'] },
    });
    const result = await createHumanReadAuthority(identity({ scopes: ['cauce.read'] }), f.pinned, signal(), f.identityStore)(f.client);
    expect(result).toEqual(f.pinned);
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.identityStore.lock).toHaveBeenCalledExactlyOnceWith(f.client,
      { provider: 'oauth', namespace: identity().issuer, subject: identity().subject }, user.id);
    expect(f.identityStore.resolve).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(1);
    await expect(createHumanPublishAuthority(identity(), f.pinned, signal(), f.identityStore)(f.client))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it.each([[], ['cauce.publish'], ['read'], ['unrelated']].map((scopes) => ({ scopes })))('requires the verified read scope: $scopes', async ({ scopes }) => {
    const f = durableFixture();
    await expect(createHumanReadAuthority(identity({ scopes }), f.pinned, signal(), f.identityStore)(f.client))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('accepts read scope duplicates but does not infer membership read permission from role or route', async () => {
    const f = durableFixture();
    const authorize = createHumanReadAuthority(identity({ scopes: ['cauce.read', 'cauce.read'] }), f.pinned, signal(), f.identityStore);
    await expect(authorize(f.client)).resolves.toEqual(f.pinned);
    f.identityStore.lock.mockResolvedValue({ ...f.record, membership: { ...f.record.membership, permissions: ['route'] } });
    await expect(authorize(f.client)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.identityStore.lock).toHaveBeenCalledTimes(2);
  });

  it.each(['account', 'membership', 'binding'] as const)('revalidates fresh %s revocation on every callback', async (source) => {
    const f = durableFixture();
    const authorize = createHumanReadAuthority(identity(), f.pinned, signal(), f.identityStore);
    await expect(authorize(f.client)).resolves.toEqual(f.pinned);
    if (source === 'account') f.identityStore.lock.mockResolvedValue({ ...f.record, account: { ...f.record.account, active: false } });
    else if (source === 'membership') f.identityStore.lock.mockResolvedValue({ ...f.record, membership: { ...f.record.membership, enabled: false } });
    else f.identityStore.lock.mockRejectedValue(new StoreError('forbidden', 'human identity is unavailable'));
    await expect(authorize(f.client)).rejects.toBeDefined();
    expect(f.identityStore.lock).toHaveBeenCalledTimes(2);
  });

  it.each(['account', 'membership'] as const)('fails closed for an unknown %s role', async (source) => {
    const f = durableFixture();
    f.identityStore.lock.mockResolvedValue({ ...f.record, [source]: { ...f.record[source], role: 'unknown' } });
    await expect(createHumanReadAuthority(identity(), f.pinned, signal(), f.identityStore)(f.client)).rejects.toBeInstanceOf(AuthError);
  });

  it.each(['humanId', 'tenantId', 'actorAlias'] as const)('rejects a changed pinned %s', async (field) => {
    const f = durableFixture();
    const pinned = { ...f.pinned, [field]: field === 'humanId' ? '00000000-0000-4000-8000-000000000082'
      : field === 'tenantId' ? 'Jhon' : 'different-human' };
    await expect(createHumanReadAuthority(identity(), pinned, signal(), f.identityStore)(f.client))
      .rejects.toMatchObject({ code: 'conflict', message: 'human read identity changed' });
  });

  it('pins immutable copies of the verified identity, scopes, and server identity', async () => {
    const f = durableFixture();
    const verified = { ...identity(), scopes: ['cauce.read'] };
    const authorize = createHumanReadAuthority(verified, f.pinned, signal(), f.identityStore);
    verified.issuer = 'changed'; verified.subject = 'changed'; verified.expiresAt = 0; verified.scopes.length = 0;
    f.pinned.humanId = 'changed'; f.pinned.actorAlias = 'changed';
    await expect(authorize(f.client)).resolves.toEqual({ humanId: user.id, tenantId: 'Steven', actorAlias: 'member-human' });
    expect(f.identityStore.lock).toHaveBeenCalledWith(f.client,
      { provider: 'oauth', namespace: identity().issuer, subject: identity().subject }, user.id);
  });

  it.each([0, NaN, Infinity])('rejects expired or invalid expiry %s before SQL', async (expiresAt) => {
    const f = durableFixture();
    await expect(createHumanReadAuthority(identity({ expiresAt }), f.pinned, signal(), f.identityStore)(f.client)).rejects.toBeInstanceOf(AuthError);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.identityStore.lock).not.toHaveBeenCalled();
  });

  it('rejects pre-abort before SQL and preserves the cancellation reason', async () => {
    const f = durableFixture();
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(createHumanReadAuthority(identity(), f.pinned, controller.signal, f.identityStore)(f.client)).rejects.toBe(controller.signal.reason);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.identityStore.lock).not.toHaveBeenCalled();
  });

  it.each(['expiry', 'abort'] as const)('rechecks %s after locks are acquired', async (mode) => {
    vi.useFakeTimers();
    const f = durableFixture();
    const controller = new AbortController();
    const verified = identity({ expiresAt: Date.now() / 1000 + 1 });
    const reason = new Error('cancelled');
    f.identityStore.lock.mockImplementation(async () => {
      if (mode === 'expiry') vi.setSystemTime(Date.now() + 1000);
      else controller.abort(reason);
      return f.record;
    });
    const result = expect(createHumanReadAuthority(verified, f.pinned, controller.signal, f.identityStore)(f.client)).rejects;
    if (mode === 'expiry') await result.toBeInstanceOf(AuthError);
    else await result.toBe(reason);
  });

  it.each([1, 1200, 10000])('caps SQL timeouts to min(5000, JWT lifetime) for %s milliseconds', async (remaining) => {
    vi.useFakeTimers();
    vi.setSystemTime(2000000);
    const f = durableFixture();
    await createHumanReadAuthority(identity({ expiresAt: (Date.now() + remaining) / 1000 }), f.pinned, signal(), f.identityStore)(f.client);
    expect(f.query).toHaveBeenCalledExactlyOnceWith(
      "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(Math.min(5000, remaining))]);
    expect(f.query.mock.invocationCallOrder[0]).toBeLessThan(f.identityStore.lock.mock.invocationCallOrder[0] ?? 0);
  });

  it('defaults to canonical account, binding, membership locks on the caller client without owning a transaction', async () => {
    const rows = [[], ...lockedRows()];
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: rows.shift() ?? [] }));
    const f = durableFixture();
    const client = { query } as unknown as DatabaseClient;
    await expect(createHumanReadAuthority(identity(), f.pinned, signal())(client)).resolves.toEqual(f.pinned);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("set_config('statement_timeout'"),
      expect.stringMatching(/^SELECT human_id FROM human_external_identities/),
      expect.stringMatching(/FROM console_users WHERE id=\$1 FOR SHARE$/),
      expect.stringMatching(/FROM human_external_identities[\s\S]+FOR SHARE$/),
      expect.stringMatching(/FROM human_tenant_memberships WHERE human_id=\$1 AND tenant_id=\$2 FOR SHARE$/),
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual(['oauth', identity().issuer, identity().subject]);
    expect(query.mock.calls[2]?.[1]).toEqual([user.id]);
    expect(query.mock.calls[3]?.[1]).toEqual(query.mock.calls[1]?.[1]);
    expect(query.mock.calls[4]?.[1]).toEqual([user.id, 'Steven']);
  });
});
