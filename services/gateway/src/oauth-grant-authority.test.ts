import type { DatabaseClient, HumanIdentitySnapshot } from '@cauce/store';
import { describe, expect, it, vi } from 'vitest';
import { OAuthTokens as LocalTokens } from './oauth-tokens.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import { configuredHumanMcp } from './mcp-configuration.js';
import { currentOAuthScopes, createLocalOAuthAuthorization, lockOAuthAccess } from './oauth-grant-authority.js';
import type { OAuthAccessIdentity } from './oauth-authorization-types.js';
import type { OAuthTokens } from './oauth-tokens.js';
import { createHumanReadAuthority } from './human-mcp-authority.js';

const userId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const tokenId = '44444444-4444-4444-8444-444444444444';
const stamp = 's'.repeat(43);
const verifyCredentialStamp = (value: string) => value === stamp;
const issuer = 'https://cauce.example';
const identity: OAuthAccessIdentity = { kind: 'oauth', authorizationServer: 'local', issuer, subject: userId, audience: `${issuer}/mcp`,
  expiresAt: Math.floor(Date.now() / 1000) + 300, grantId, tokenId, scopes: ['cauce.read'] };
const snapshot: HumanIdentitySnapshot = { provider: 'oauth', namespace: issuer, subject: userId, humanId: userId,
  bindingId, bindingRevision: '2', account: { active: true, role: 'operator', defaultTenant: 'Steven', displayName: 'Fixture' },
  membership: { tenantId: 'Steven', actorAlias: 'kant', role: 'operator', permissions: ['read', 'route'], enabled: true, revision: '3' } };

function client(override: Record<string, unknown> = {}, absentToken = false, disabled = false, unavailable?: 'binding' | 'membership') {
  const query = vi.fn(async (sql: string) => {
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('SELECT human_id')) rows = [{ human_id: userId }];
    else if (sql.includes('FROM console_users')) rows = [{ id: userId, active: !disabled, role: 'operator', tenant_id: 'Steven', display_name: 'Fixture', alias: 'kant', password_hash: 'fixture-hash', password_changed_at_us: '0', password_changed_at: new Date(0) }];
    else if (sql.includes('FROM human_external_identities')) rows = [{ id: bindingId, human_id: userId, revision: '2', enabled: unavailable !== 'binding', revoked_at: unavailable === 'binding' ? new Date() : null }];
    else if (sql.includes('FROM human_tenant_memberships')) rows = [{ tenant_id: 'Steven', actor_alias: 'kant', role: 'operator', permissions: ['read', 'route'], enabled: unavailable !== 'membership', revision: '3', revoked_at: unavailable === 'membership' ? new Date() : null }];
    else if (sql.includes('SELECT credential_stamp')) rows = [{ credential_stamp: typeof override.credential_stamp === 'string' ? override.credential_stamp : stamp }];
    else if (sql.includes('AS valid')) rows = [{ valid: true }];
    else if (sql.includes('FROM cauce_oauth_grants')) rows = [{ id: grantId, human_id: userId, scopes: ['cauce.read'], expires_at: new Date(identity.expiresAt * 1000), credential_stamp: stamp,
      binding_id: bindingId, binding_revision: '2', membership_revision: '3', tenant_id: 'Steven', actor_alias: 'kant', ...override }];
    else if (sql.includes('FROM cauce_oauth_tokens') && !absentToken) rows = [{ expires_at: new Date(identity.expiresAt * 1000) }];
    return { rows, rowCount: rows.length };
  });
  return { client: { query } as unknown as DatabaseClient, query };
}

describe('OAuth live authority contracts without PostgreSQL', () => {
  it('intersects consent with both current roles and membership permissions', () => {
    expect(currentOAuthScopes(snapshot)).toEqual(['cauce.read', 'cauce.publish']);
    expect(currentOAuthScopes({ ...snapshot, account: { ...snapshot.account, role: 'reader' } })).toEqual(['cauce.read']);
    expect(currentOAuthScopes({ ...snapshot, membership: { ...snapshot.membership, permissions: [] } })).toEqual([]);
  });
  it('takes shared locks and requires matching token expiration', async () => {
    const fake = client();
    await expect(lockOAuthAccess(fake.client, identity, issuer, identity.audience, verifyCredentialStamp)).resolves.toBeUndefined();
    expect(fake.query.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes('FOR SHARE'))).toHaveLength(7);
    await expect(lockOAuthAccess(fake.client, { ...identity, expiresAt: 19_999 }, issuer, identity.audience, verifyCredentialStamp)).rejects.toThrow('invalid_grant');
  });
  it.each([{ binding_revision: '4' }, { membership_revision: '4' }, { actor_alias: 'other' }, { tenant_id: 'Other' },
    { scopes: ['cauce.publish'] }, { scopes: [] }, { credential_stamp: 'z'.repeat(43) }])('rejects stale grant authority %j', async (override) => {
    await expect(lockOAuthAccess(client(override).client, identity, issuer, identity.audience, verifyCredentialStamp)).rejects.toThrow();
  });
  it('rejects missing token, disabled account and wrong resource', async () => {
    await expect(lockOAuthAccess(client({}, true).client, identity, issuer, identity.audience, verifyCredentialStamp)).rejects.toThrow();
    await expect(lockOAuthAccess(client({}, false, true).client, identity, issuer, identity.audience, verifyCredentialStamp)).rejects.toThrow();
    await expect(lockOAuthAccess(client().client, identity, issuer, `${issuer}/other`, verifyCredentialStamp)).rejects.toThrow('invalid_grant');
  });
  it('revalidates grant and token inside the existing business-operation fence', async () => {
    const authorize = createHumanReadAuthority(identity, { humanId: userId, tenantId: 'Steven', actorAlias: 'kant' }, new AbortController().signal, { lock: async (db, key, id) => (await import('@cauce/store')).lockHumanIdentity(db, key, id), verifyCredentialStamp });
    await expect(authorize(client().client)).resolves.toEqual({ humanId: userId, tenantId: 'Steven', actorAlias: 'kant' });
    await expect(authorize(client({}, true).client)).rejects.toThrow('invalid_grant');
    await expect(authorize(client({ membership_revision: '99' }).client)).rejects.toThrow('invalid_grant');
  });
  it('fails closed if the local identity loses its durable token proof', async () => {
    const { grantId: _grantId, tokenId: _tokenId, ...incomplete } = identity;
    const authorize = createHumanReadAuthority(incomplete, { humanId: userId, tenantId: 'Steven', actorAlias: 'kant' }, new AbortController().signal, { lock: async (db, key, id) => (await import('@cauce/store')).lockHumanIdentity(db, key, id), verifyCredentialStamp });
    await expect(authorize(client().client)).rejects.toThrow();
  });
  it('requires a verified bearer and durable validation with no cookie conversion', async () => {
    const verify = vi.fn(() => identity);
    const validate = vi.fn(async () => false);
    const tokens = { issuer, resource: identity.audience, verify } as unknown as OAuthTokens;
    const auth = createLocalOAuthAuthorization(tokens, { validate });
    expect(await auth.authenticateIdentity('cookie=secret')).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    expect(await auth.authenticateIdentity('Bearer fixture')).toBeUndefined();
    validate.mockResolvedValue(true);
    expect(await auth.authenticateIdentity('Bearer fixture')).toEqual(identity);
  });
});


describe('configured remote authority on the resource origin', () => {
  it('keeps remote verification remote despite matching issuer and signed grant claims', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const tokens = new LocalTokens({ issuer, resource: identity.audience, signingKey: privateKey, kid: 'remote-fixture' });
    const issued = tokens.issue({ userId, grantId, scopes: ['cauce.read'], expiresAt: identity.expiresAt }).token.split('.');
    const claims = JSON.parse(Buffer.from(issued[1] ?? '', 'base64url').toString()) as Record<string, unknown>;
    const body = `${issued[0] ?? ''}.${Buffer.from(JSON.stringify({ ...claims, authorizationServer: 'local' })).toString('base64url')}`;
    const token = `${body}.${sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(tokens.jwks()))));
    try {
      const configuration = configuredHumanMcp({ CAUCE_MCP_PUBLIC_ORIGIN: issuer, CAUCE_MCP_OAUTH_ISSUER: issuer,
        CAUCE_MCP_OAUTH_JWKS_URI: `${issuer}/remote-jwks` });
      const verified = await configuration?.authorization.authenticateIdentity(`Bearer ${token}`);
      expect(verified).toBeDefined();
      expect(verified).not.toHaveProperty('grantId');
      expect(verified).not.toHaveProperty('authorizationServer');
      if (!verified) throw new Error('fixture verification failed');
      const fake = client();
      await expect(createHumanReadAuthority(verified, { humanId: userId, tenantId: 'Steven', actorAlias: 'kant' },
        new AbortController().signal)(fake.client)).resolves.toEqual({ humanId: userId, tenantId: 'Steven', actorAlias: 'kant' });
      expect(fake.query.mock.calls.some(([sql]) => sql.includes('cauce_oauth_grants'))).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});


describe('SQL fixture without durable revision triggers', () => {
  it.each(['binding', 'membership'] as const)('reproduces grant revival if %s is re-enabled with the same revision', async (kind) => {
    await expect(lockOAuthAccess(client().client, identity, issuer, identity.audience, verifyCredentialStamp)).resolves.toBeUndefined();
    await expect(lockOAuthAccess(client({}, false, false, kind).client, identity, issuer, identity.audience, verifyCredentialStamp)).rejects.toThrow();
    await expect(lockOAuthAccess(client().client, identity, issuer, identity.audience, verifyCredentialStamp)).resolves.toBeUndefined();
  });
});
