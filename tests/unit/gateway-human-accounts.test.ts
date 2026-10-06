import type { FastifyInstance } from 'fastify';
import { CauceRepository, StoreError, type DatabaseClient, type HumanPublishProvenance } from '@cauce/store';
import type { ConsoleUser } from '../../services/gateway/src/console-users.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixedAuthProvider, ids } from '../../services/gateway/src/test-support/gateway-doubles.js';
import { humanAccounts, loginAs, message, publishAs } from './gateway-human-accounts-fixtures.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  try { await Promise.all(apps.splice(0).map((app) => app.close())); }
  finally { vi.restoreAllMocks(); }
});

function humanAuthorityClient(users: readonly ConsoleUser[]): DatabaseClient {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const user = users.find((entry) => entry.id === values[0]);
    if (sql.startsWith("SELECT set_config('statement_timeout'")) return { rows: [], rowCount: 0 };
    if (user === undefined) throw new Error('unknown human authority fixture');
    if (sql.includes('FROM console_users')) return { rows: [{ ...user,
      password_changed_at: new Date(user.password_changed_at),
      password_changed_at_us: String(user.password_changed_at * 1_000),
    }], rowCount: 1 };
    if (sql.includes('FROM human_tenant_memberships') && values[1] === user.tenant_id) return {
      rows: [{ tenant_id: user.tenant_id, actor_alias: user.alias, role: user.role,
        permissions: ['route', 'read'], enabled: true, revision: '1', revoked_at: null }], rowCount: 1,
    };
    throw new Error('unexpected human authority SQL');
  });
  return { query } as unknown as DatabaseClient;
}

describe('authenticated human accounts through the existing console gateway', () => {
  it('switches between two people sharing a technical scope while preserving their own authors and intent scopes', async () => {
    const test = await humanAccounts();
    apps.push(test.app);
    const first = await loginAs(test.app, test.first);
    expect(first.state).toMatchObject({ subject: test.first.email, name: 'Alba' });
    await publishAs(test.app, first.headers);
    const closed = await test.app.inject({ method: 'POST', url: '/v3/auth/logout', headers: first.headers });
    expect(closed.statusCode).toBe(204);
    expect(closed.headers['set-cookie']).toContain('Max-Age=0');
    const signedOut = await test.app.inject({ method: 'GET', url: '/v3/auth/session' });
    expect(signedOut.json()).toEqual({ authenticated: false, login_mode: 'password' });

    const second = await loginAs(test.app, test.other);
    expect(second.state).toMatchObject({ subject: test.other.email, name: 'Bruno' });
    expect(second.cookie).not.toBe(first.cookie);
    expect(second.state.csrf_token).not.toBe(first.state.csrf_token);
    const state = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: second.headers });
    expect(state.json()).toEqual(second.state);
    await publishAs(test.app, second.headers);

    const authors = test.publish.mock.calls.map(([command, options]) => {
      expect(command).toMatchObject({ tenant_id: 'Steven', actor_alias: 'kant' });
      expect(options?.requirePreparedConsoleIntent).toBe(true);
      return options?.consoleAuthor;
    });
    expect(authors.map((author) => author?.display_name)).toEqual(['Alba', 'Bruno']);
    expect(authors[0]?.subject_id).toMatch(/^human:[a-f0-9]{64}$/u);
    expect(authors[1]?.subject_id).toMatch(/^human:[a-f0-9]{64}$/u);
    expect(authors[0]?.subject_id).not.toBe(authors[1]?.subject_id);
    expect(JSON.stringify(authors)).not.toContain('@example.test');
    const scopes = test.prepare.mock.calls.map(([, scope]) => scope);
    expect(scopes[0]).not.toBe(scopes[1]);
    expect(test.publish.mock.calls.map(([, options]) => options?.consoleIntentOperatorScope)).toEqual(scopes);
    expect(vi.mocked(test.repository.confirmConsolePublishIntent).mock.calls.map((call) => call[2])).toEqual(scopes);
    for (const session of [first, second]) {
      const access = await test.app.inject({ method: 'GET', url: '/v3/console/access', headers: session.headers });
      expect(access.json()).toMatchObject({ subject: 'Steven:kant' });
    }
  });

  it('keeps the stable human subject when the server profile changes and leaves the earlier snapshot unchanged', async () => {
    const test = await humanAccounts();
    apps.push(test.app);
    const session = await loginAs(test.app, test.first);
    await publishAs(test.app, session.headers);
    test.users.put({ ...test.first, display_name: 'Alba nueva' });
    const state = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: session.headers });
    expect(state.json()).toMatchObject({ name: 'Alba nueva' });
    await publishAs(test.app, session.headers);
    const authors = test.publish.mock.calls.map(([, options]) => options?.consoleAuthor);
    expect(authors.map((author) => author?.display_name)).toEqual(['Alba', 'Alba nueva']);
    expect(authors[0]?.subject_id).toBe(authors[1]?.subject_id);
    expect(test.prepare.mock.calls[0]?.[1]).toBe(test.prepare.mock.calls[1]?.[1]);
  });

  it.each([
    { tenant_id: 'Steven', alias: 'argos' },
    { tenant_id: 'Pablo', alias: 'kant' },
  ])('preserves the existing visibility boundary for $tenant_id:$alias', async (identity) => {
    const test = await humanAccounts(identity);
    apps.push(test.app);
    const rows = [test.first, test.other].map((user, index) => ({
      message_id: index === 0 ? ids.message : ids.delivery,
      tenant_id: user.tenant_id, actor_alias: user.alias, deliveries: [],
    }));
    vi.mocked(test.repository.listMessages).mockResolvedValue({ items: rows });
    const own = rows[0];
    if (own === undefined) throw new Error('expected the first account message');
    const client = humanAuthorityClient([test.first, test.other]);
    const scopes: Readonly<HumanPublishProvenance>[] = [];
    const detailStore = vi.spyOn(CauceRepository.prototype, 'getHumanMessage').mockImplementation(async (messageId, options) => {
      expect(messageId).toBe(ids.message);
      expect(messageId).toMatch(/^[a-f0-9-]{36}$/u);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted).toBe(false);
      const scope = await options.humanAuthority(client);
      scopes.push(scope);
      if (scope.humanId !== test.first.id || scope.tenantId !== test.first.tenant_id
          || scope.actorAlias !== test.first.alias) throw new StoreError('not_found', 'message not owned');
      return own;
    });
    const legacyStore = vi.spyOn(CauceRepository.prototype, 'getLegacyHumanMessage').mockImplementation(async (messageId, options) => {
      expect(messageId).toBe(ids.message);
      expect(options.signal.aborted).toBe(false);
      const scope = await options.humanAuthority(client);
      expect(scope).toEqual({ humanId: test.other.id, tenantId: test.other.tenant_id, actorAlias: test.other.alias });
      throw new StoreError('not_found', 'message has a different human ledger owner');
    });
    for (const [index, user] of [test.first, test.other].entries()) {
      const session = await loginAs(test.app, user);
      const access = await test.app.inject({ method: 'GET', url: '/v3/console/access', headers: session.headers });
      expect(access.json()).toMatchObject({ subject: `${user.tenant_id}:${user.alias}` });
      const messages = await test.app.inject({ method: 'GET', url: '/v3/console/messages', headers: session.headers });
      expect(messages.statusCode).toBe(200);
      expect(messages.json()).toEqual({ items: [rows[index]] });
      expect(test.repository.listMessages).toHaveBeenLastCalledWith(user.tenant_id, user.alias);
      const detail = await test.app.inject({ method: 'GET', url: `/v3/console/messages/${ids.message}`, headers: session.headers });
      expect(detail.statusCode).toBe(index === 0 ? 200 : 404);
    }
    expect(scopes).toEqual([test.first, test.other].map((user) => ({
      humanId: user.id, tenantId: user.tenant_id, actorAlias: user.alias,
    })));
    expect(detailStore).toHaveBeenCalledTimes(2);
    expect(legacyStore).toHaveBeenCalledOnce();
    expect(test.repository.getMessage).not.toHaveBeenCalled();
  });

  it('retains deliberate shared-alias visibility without treating the profile as a new privacy boundary', async () => {
    const test = await humanAccounts();
    apps.push(test.app);
    const shared = { message_id: ids.message, tenant_id: 'Steven', actor_alias: 'kant', deliveries: [] };
    vi.mocked(test.repository.listMessages).mockResolvedValue({ items: [shared] });
    for (const user of [test.first, test.other]) {
      const session = await loginAs(test.app, user);
      const response = await test.app.inject({ method: 'GET', url: '/v3/console/messages', headers: session.headers });
      expect(response.json()).toEqual({ items: [shared] });
    }
  });

  it('keeps each account role independent and uses only the active session CSRF token', async () => {
    const test = await humanAccounts({ role: 'reader' });
    apps.push(test.app);
    const operator = await loginAs(test.app, test.first);
    const reader = await loginAs(test.app, test.other);
    expect(reader.state).toMatchObject({ name: 'Bruno', roles: [], permissions: ['read'] });
    const access = await test.app.inject({ method: 'GET', url: '/v3/console/access', headers: reader.headers });
    expect(access.json()).toMatchObject({ subject: 'Steven:kant', roles: [], permissions: [] });
    const response = await test.app.inject({
      method: 'POST', url: '/v3/console/messages', headers: reader.headers,
      payload: { ...message, idempotency_key: 'console:reader-test' },
    });
    expect(response.statusCode).toBe(403);
    const mixed = await test.app.inject({
      method: 'POST', url: '/v3/auth/logout', headers: { ...reader.headers, 'x-csrf-token': operator.headers['x-csrf-token'] },
    });
    expect(mixed.statusCode).toBe(403);
    expect(test.publish).not.toHaveBeenCalled();
  });

  it('keeps an authenticated service actor distinct from the human sessions', async () => {
    const fallback = new FixedAuthProvider({
      tenant_id: 'Steven', alias: 'jarvis', session_id: 'synthetic-service', channel: 'adapter',
      roles: ['agent'], permissions: ['route', 'read'],
    });
    const test = await humanAccounts({}, fallback);
    apps.push(test.app);
    const session = await loginAs(test.app, test.first);
    await publishAs(test.app, session.headers);
    const service = await test.app.inject({
      method: 'POST', url: '/v3/messages', headers: { origin: 'http://localhost' },
      payload: { ...message, idempotency_key: 'synthetic-service-message' },
    });
    expect(service.statusCode).toBe(202);
    expect(test.publish.mock.calls[1]?.[0]).toMatchObject({ actor_alias: 'jarvis' });
    expect(test.publish.mock.calls[1]?.[1]?.consoleAuthor).toBeUndefined();
    expect(test.publish.mock.calls[0]?.[1]?.consoleAuthor?.display_name).toBe('Alba');
  });
});
