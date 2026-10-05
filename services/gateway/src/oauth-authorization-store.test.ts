import { EventEmitter } from 'node:events';
import type { DatabasePool } from '@cauce/store';
import { describe, expect, it, vi } from 'vitest';
import { PostgresOAuthStore } from './oauth-authorization-store.js';
import { secretHash, type OAuthAuthorizationRequest, type OAuthIssuedToken, type OAuthTokenInput } from './oauth-authorization-types.js';

const issuer = 'https://cauce.example';
const userId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const tokenId = '44444444-4444-4444-8444-444444444444';
const request: OAuthAuthorizationRequest = { idHash: secretHash('id'), browserHash: secretHash('browser'),
  clientId: 'https://client.example/doc', clientName: 'Fixture', redirectUri: 'https://client.example/callback',
  resource: `${issuer}/mcp`, scopes: ['cauce.read', 'cauce.publish'], challenge: 'x'.repeat(43), state: 'opaque-state' };
const stamp = 's'.repeat(43);
const session = { userId, credentialStamp: stamp, issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt: Math.floor(Date.now() / 1000) + 3600, csrf: 'c'.repeat(43) };
const context = () => ({ signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
const exchange = { codeHash: secretHash('code'), clientId: request.clientId, redirectUri: request.redirectUri,
  resource: request.resource, challenge: request.challenge };
function issue(input: OAuthTokenInput): OAuthIssuedToken {
  return { token: 'signed-fixture', identity: { kind: 'oauth', authorizationServer: 'local', issuer, subject: input.userId,
    audience: request.resource, grantId: input.grantId, tokenId, expiresAt: Math.floor(Date.now() / 1000) + 300, scopes: input.scopes } };
}

function fixture(consumeCount = 1, challenge = request.challenge, sessionActive = true, hook?: (sql: string) => Promise<void>, refreshConsumed = false) {
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    await hook?.(sql);
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('FROM cauce_oauth_requests WHERE')) rows = [{ id_hash: request.idHash, browser_hash: request.browserHash,
      client_id: request.clientId, client_name: request.clientName, redirect_uri: request.redirectUri,
      resource: request.resource, scopes: request.scopes, challenge: request.challenge, state: request.state }];
    else if (sql.includes('SELECT human_id')) rows = [{ human_id: userId }];
    else if (sql.includes('FROM console_users')) rows = [{ id: userId, active: true, role: 'operator', tenant_id: 'Steven', alias: 'kant', display_name: 'Fixture', password_hash: 'fixture-hash', password_changed_at_us: '10000000000', password_changed_at: new Date(0) }];
    else if (sql.includes('FROM human_external_identities')) rows = [{ id: bindingId, human_id: userId, revision: '2', enabled: true, revoked_at: null }];
    else if (sql.includes('FROM human_tenant_memberships')) rows = [{ tenant_id: 'Steven', actor_alias: 'kant', role: 'operator', permissions: ['read', 'route'], enabled: true, revision: '3', revoked_at: null }];
    else if (sql.includes('SELECT c.grant_id')) rows = [{ grant_id: grantId, human_id: userId }];
    else if (sql.includes('FROM cauce_oauth_refresh_tokens r')) rows = [{ grant_id: grantId, human_id: userId, client_id: request.clientId, consumed: refreshConsumed }];
    else if (sql.includes('FROM cauce_oauth_refresh_tokens WHERE')) rows = [{ consumed: false, live: true }];
    else if (sql.includes('SELECT credential_stamp')) rows = [{ credential_stamp: stamp }];
    else if (sql.includes('AS valid')) rows = [{ valid: true }];
    else if (sql.includes('FROM cauce_oauth_grants g')) rows = [{ id: grantId, human_id: userId, client_id: request.clientId,
      redirect_uri: request.redirectUri, scopes: ['cauce.read'], expires_at: new Date(session.expiresAt * 1000), binding_id: bindingId,
      binding_revision: '2', membership_revision: '3', tenant_id: 'Steven', actor_alias: 'kant', credential_stamp: stamp }];
    else if (sql.includes('SELECT challenge FROM cauce_oauth_codes')) rows = [{ challenge }];
    return { rows, rowCount: /UPDATE cauce_oauth_(codes|requests|refresh_tokens)/u.test(sql) ? consumeCount
      : sql.includes('INSERT INTO cauce_oauth_refresh_tokens') ? 1 : rows.length };
  });
  const release = vi.fn();
  const client = Object.assign(new EventEmitter(), { query, release });
  const pool = { query, connect: vi.fn(async () => client) } as unknown as DatabasePool;
  return { query, release, client, store: new PostgresOAuthStore(pool, issuer, value => sessionActive && value === stamp) };
}

describe('OAuth SQL contracts with an injected database client', () => {
  it('stores the original session stamp without generating one from the locked row', async () => {
    const fake = fixture();
    await fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context());
    const insert = fake.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO cauce_oauth_grants'));
    expect(insert?.[1]?.[12]).toBe(session.credentialStamp);
    expect(insert?.[0]).not.toContain('password_version');
  });
  it('creates the local binding from the console user inside consent and refuses an unusable binding', async () => {
    const fake = fixture();
    await fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context());
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    const insert = fake.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO human_external_identities'));
    expect(insert?.[0]).toContain('FROM console_users WHERE id=$1 AND active');
    expect(insert?.[0]).toContain('ON CONFLICT (provider,namespace,subject) DO NOTHING');
    expect(insert?.[1]).toEqual([userId, issuer]);
    expect(statements.findIndex(sql => sql.includes('INSERT INTO human_external_identities')))
      .toBeLessThan(statements.findIndex(sql => sql.includes('SELECT human_id')));
    const missing = fixture(1, request.challenge, true, async () => undefined);
    missing.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await expect(missing.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context())).rejects.toThrow('access_denied');
    const denied = fixture();
    await denied.store.consent(request.idHash, request.browserHash, session, undefined, context());
    expect(denied.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO human_external_identities'))).toBe(false);
  });
  it('rejects stale session stamps under locks and rolls back without consuming the request', async () => {
    const fake = fixture();
    await expect(fake.store.consent(request.idHash, request.browserHash,
      { ...session, credentialStamp: 'z'.repeat(43) }, ['cauce.read'], context())).rejects.toThrow('access_denied');
    expect(fake.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(fake.query.mock.calls.some(([sql]) => sql.includes('UPDATE cauce_oauth_requests'))).toBe(false);
  });

  it('checks schema at readiness without creating tables', async () => {
    const fake = fixture();
    await fake.store.ready();
    expect(fake.query).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls[0]?.[0]).toContain('LIMIT 0');
    expect(fake.query.mock.calls[0]?.[0]).not.toMatch(/CREATE|ALTER/u);
  });
  it('consumes a code and records the issued token before COMMIT', async () => {
    const fake = fixture();
    expect(await fake.store.exchange(exchange, issue, context())).toMatchObject({ identity: { grantId, tokenId } });
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    expect(statements.indexOf('COMMIT')).toBeGreaterThan(statements.findIndex((sql) => sql.includes('INSERT INTO cauce_oauth_tokens')));
    expect(statements.find((sql) => sql.includes('UPDATE cauce_oauth_codes'))).toContain('consumed_at IS NULL');
    expect(fake.release).toHaveBeenCalledOnce();
  });
  it('rolls back failed consume and never records a token', async () => {
    const fake = fixture(0);
    await expect(fake.store.exchange(exchange, issue, context())).rejects.toThrow('invalid_grant');
    expect(fake.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(fake.query.mock.calls.map(([sql]) => sql).some((sql) => sql.includes('INSERT INTO cauce_oauth_tokens'))).toBe(false);
  });
  it('rolls back signing failure without consuming the code', async () => {
    const fake = fixture();
    await expect(fake.store.exchange(exchange, () => { throw new Error('signing unavailable'); }, context())).rejects.toThrow('signing unavailable');
    expect(fake.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(fake.query.mock.calls.map(([sql]) => sql).some((sql) => sql.includes('UPDATE cauce_oauth_codes'))).toBe(false);
  });
  it.each([{ resource: `${issuer}/other` }, { clientId: 'https://other.example/doc' },
    { redirectUri: 'https://client.example/other' }])('rejects changed exchange binding %j', async (override) => {
    const fake = fixture();
    await expect(fake.store.exchange({ ...exchange, ...override }, issue, context())).rejects.toThrow('invalid_grant');
  });
  it('rejects a wrong PKCE challenge before issuing', async () => {
    const fake = fixture(1, 'y'.repeat(43));
    const signer = vi.fn(issue);
    await expect(fake.store.exchange(exchange, signer, context())).rejects.toThrow('invalid_grant');
    expect(signer).not.toHaveBeenCalled();
  });
  it('hashes the returned consent code and stores canonical consent scopes', async () => {
    const fake = fixture();
    const result = await fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read', 'cauce.read'], context());
    expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const codeInsert = fake.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO cauce_oauth_codes'));
    expect(codeInsert?.[1]?.[0]).toBe(secretHash(result.code ?? ''));
    const grantInsert = fake.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO cauce_oauth_grants'));
    expect(grantInsert?.[1]?.[6]).toEqual(['cauce.read']);
  });
  it('denial consumes only the request and creates neither code nor grant', async () => {
    const fake = fixture();
    expect(await fake.store.consent(request.idHash, request.browserHash, session, undefined, context())).not.toHaveProperty('code');
    expect(fake.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO cauce_oauth_grants') || sql.includes('INSERT INTO cauce_oauth_codes'))).toBe(false);
  });
  it('checks the live password session before consent or revocation', async () => {
    const fake = fixture(1, request.challenge, false);
    await expect(fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context())).rejects.toThrow('access_denied');
    await expect(fake.store.revoke(grantId, session, context())).rejects.toThrow('access_denied');
  });
  it('scopes revocation to the current human, issuer and resource', async () => {
    const fake = fixture();
    await fake.store.revoke(grantId, session, context());
    expect(fake.query.mock.calls.find(([sql]) => sql.includes('UPDATE cauce_oauth_grants'))?.[1]).toEqual([grantId, userId, issuer, request.resource]);
  });
});


describe('OAuth refresh rotation with an injected database client', () => {
  const refresh = { tokenHash: secretHash('refresh'), clientId: request.clientId, resource: request.resource, scopes: undefined };
  it('rotates under the grant locks and stores only the new refresh hash', async () => {
    const fake = fixture();
    const result = await fake.store.refresh(refresh, issue, context());
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    const lock = statements.findIndex(sql => sql.includes('FROM cauce_oauth_grants g'));
    expect(lock).toBeGreaterThan(-1);
    expect(statements.findIndex(sql => sql.includes('FROM cauce_oauth_refresh_tokens WHERE') && sql.includes('FOR UPDATE'))).toBeGreaterThan(lock);
    const stored = fake.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO cauce_oauth_refresh_tokens'));
    expect(stored?.[1]?.[0]).toBe(secretHash(result.refreshToken));
    expect(JSON.stringify(fake.query.mock.calls)).not.toContain(result.refreshToken);
    expect(statements.at(-1)).toBe('COMMIT');
  });
  it('commits the grant revocation before rejecting a reused refresh token', async () => {
    const fake = fixture(1, request.challenge, true, undefined, true);
    await expect(fake.store.refresh(refresh, issue, context())).rejects.toThrow('invalid_grant');
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    expect(statements.findIndex(sql => sql.includes('UPDATE cauce_oauth_grants SET revoked_at'))).toBeLessThan(statements.indexOf('COMMIT'));
    expect(statements.some(sql => sql.includes('INSERT INTO cauce_oauth_tokens'))).toBe(false);
  });
  it.each([{ clientId: 'https://other.example/doc' }, { resource: `${issuer}/other` }, { scopes: ['cauce.read', 'cauce.publish'] as const }])(
    'rejects refresh with a changed binding %j and never signs', async (override) => {
      const fake = fixture(); const signer = vi.fn(issue);
      await expect(fake.store.refresh({ ...refresh, ...override }, signer, context())).rejects.toThrow(/invalid_grant|invalid_scope/u);
      expect(signer).not.toHaveBeenCalled();
      expect(fake.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    },
  );
});


describe('OAuth transaction cancellation with injected SQL, without PostgreSQL', () => {
  it.each(['consent', 'exchange'] as const)('never starts %s for a cancelled request', async (operation) => {
    const controller = new AbortController(); controller.abort();
    const context = { signal: controller.signal, deadlineMs: Date.now() + 10_000 };
    const fake = fixture();
    const result = operation === 'consent'
      ? fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context)
      : fake.store.exchange(exchange, issue, context);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.query).not.toHaveBeenCalled();
  });
  it.each(['consent', 'exchange'] as const)('does not COMMIT %s after cancellation during a lock', async (operation) => {
    const controller = new AbortController();
    const context = { signal: controller.signal, deadlineMs: Date.now() + 10_000 };
    const fake = fixture(1, request.challenge, true, async (sql) => { if (sql.includes('FOR SHARE')) controller.abort(); });
    const result = operation === 'consent'
      ? fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context)
      : fake.store.exchange(exchange, issue, context);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    expect(fake.release).toHaveBeenCalledWith(true);
  });
  it.each(['consent', 'exchange'] as const)('does not COMMIT %s cancelled on its last insert', async (operation) => {
    const controller = new AbortController();
    const context = { signal: controller.signal, deadlineMs: Date.now() + 10_000 };
    const fake = fixture(1, request.challenge, true, async (sql) => {
      if (sql.includes(operation === 'consent' ? 'INSERT INTO cauce_oauth_codes' : 'INSERT INTO cauce_oauth_tokens')) controller.abort();
    });
    const result = operation === 'consent'
      ? fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context)
      : fake.store.exchange(exchange, issue, context);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });
  it('rejects an expired request context before connecting', async () => {
    const fake = fixture();
    await expect(fake.store.exchange(exchange, issue, { signal: new AbortController().signal, deadlineMs: Date.now() - 1 })).rejects.toThrow();
    expect(fake.query).not.toHaveBeenCalled();
  });
  it('rejects consent whose request expires after SELECT, without emitting a code', async () => {
    const fake = fixture(0);
    await expect(fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'],
      { signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 })).rejects.toThrow('invalid_request');
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    expect(statements).not.toContain('COMMIT');
    expect(statements.some(sql => sql.includes('INSERT INTO cauce_oauth_codes'))).toBe(false);
    const consumed = statements.find(sql => sql.includes('UPDATE cauce_oauth_requests'));
    expect(consumed).toContain('expires_at>clock_timestamp()');
  });
});


describe('OAuth expiration and one SQL timestamp', () => {
  it.each(['consent', 'exchange'] as const)('rejects %s when its deadline expires during a lock', async (operation) => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const context = { signal: new AbortController().signal, deadlineMs: now + 1000 };
    const fake = fixture(1, request.challenge, true, async sql => { if (sql.includes('FOR SHARE')) now += 1001; });
    try {
      const result = operation === 'consent'
        ? fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context)
        : fake.store.exchange(exchange, issue, context);
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(fake.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    } finally { clock.mockRestore(); }
  });
  it('uses a single materialized timestamp for every relative TTL insert', async () => {
    const fake = fixture();
    await fake.store.createRequest(request, context());
    await fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context());
    const statements = fake.query.mock.calls.map(([sql]) => sql).filter(sql => /INSERT INTO cauce_oauth_(requests|grants|codes)/u.test(sql));
    expect(statements).toHaveLength(3);
    for (const sql of statements) {
      expect(sql.match(/clock_timestamp\(\)/gu)).toHaveLength(1);
      expect(sql).toContain('AS MATERIALIZED');
      expect(sql).toContain('created_at');
      expect(sql).toContain('FROM instant');
    }
  });
});


describe('OAuth pending lock cancellation with a simulated transport', () => {
  it.each(['consent', 'exchange'] as const)('tears down the checked-out client while %s is awaiting a lock', async operation => {
    const controller = new AbortController();
    let entered: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let rejectLock: (error: Error) => void = () => undefined;
    const fake = fixture(1, request.challenge, true, async sql => {
      if (!sql.includes('FOR SHARE')) return;
      entered();
      await new Promise<void>((_resolve, reject) => { rejectLock = reject; });
    });
    const destroy = vi.fn(() => { rejectLock(new Error('fixture transport closed')); });
    Object.assign(fake.client, { connection: { stream: { destroy } } });
    const context = { signal: controller.signal, deadlineMs: Date.now() + 10_000 };
    const result = operation === 'consent'
      ? fake.store.consent(request.idHash, request.browserHash, session, ['cauce.read'], context)
      : fake.store.exchange(exchange, issue, context);
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await waiting; controller.abort(); await rejection;
    expect(destroy).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledWith(true);
    expect(fake.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });
});
