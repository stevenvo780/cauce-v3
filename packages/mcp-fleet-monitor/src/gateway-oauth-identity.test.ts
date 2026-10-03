import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTHeaderParameters } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOAuthIdentityVerifier } from './gateway-oauth-identity.js';

const publicOrigin = 'https://mcp.example';
const config = { issuer: 'https://auth.example/realm', jwksUri: 'https://auth.example/realm/jwks' };
let signingKey: CryptoKey;
let jwk: JWK;
const fetcher = vi.fn<typeof fetch>();

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: 'identity-key', alg: 'RS256', use: 'sig' };
});
beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ keys: [jwk] })));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());

async function signedToken(claims: Record<string, unknown>, header: JWTHeaderParameters = {
  alg: 'RS256', kid: 'identity-key', typ: 'at+jwt',
}): Promise<string> {
  return new SignJWT(claims).setProtectedHeader(header).sign(signingKey);
}

function verifier() {
  return createOAuthIdentityVerifier(publicOrigin, config);
}

describe('verified OAuth identity', () => {
  it('requires canonical HTTPS verifier endpoints', () => {
    expect(() => createOAuthIdentityVerifier('http://mcp.example', config)).toThrow();
    expect(() => createOAuthIdentityVerifier(publicOrigin, { ...config, issuer: 'https://user@auth.example' })).toThrow();
  });

  it('returns a frozen, narrow identity and ignores untrusted profile and tenancy claims', async () => {
    const verify = verifier();
    const common = {
      iss: config.issuer, aud: `${publicOrigin}/mcp`, exp: Math.floor(Date.now() / 1000) + 60,
      scope: 'cauce.read other cauce.read', tenant: 'forged', alias: 'root', email: 'root@example.test',
      name: 'Root', role: 'admin',
    };
    const first = await verify(await signedToken({ ...common, sub: 'subject-one' }));
    const second = await verify(await signedToken({ ...common, sub: 'subject-two' }));

    expect(first).toEqual({ kind: 'oauth', issuer: config.issuer, subject: 'subject-one',
      audience: `${publicOrigin}/mcp`, expiresAt: common.exp, scopes: ['cauce.read', 'other'] });
    expect(second?.subject).toBe('subject-two');
    expect(first && Object.isFrozen(first)).toBe(true);
    expect(first && Object.isFrozen(first.scopes)).toBe(true);
    expect(first).not.toHaveProperty('tenant');
    expect(first).not.toHaveProperty('alias');
    expect(first).not.toHaveProperty('email');
    expect(first).not.toHaveProperty('name');
    expect(first).not.toHaveProperty('role');
  });

  it.each([undefined, ''])('preserves a verified identity with no scopes when scope is %s', async (scope) => {
    const claims = { iss: config.issuer, aud: `${publicOrigin}/mcp`, sub: 'subject-no-scope',
      exp: Math.floor(Date.now() / 1000) + 60, ...(scope === undefined ? {} : { scope }) };
    expect(await verifier()(await signedToken(claims))).toMatchObject({ subject: 'subject-no-scope', scopes: [] });
  });

  it('rejects oversized signed credentials before fetching trusted keys', async () => {
    const token = await signedToken({ iss: config.issuer, aud: `${publicOrigin}/mcp`, sub: 'subject-valid',
      exp: Math.floor(Date.now() / 1000) + 60, scope: 'cauce.read', extra: 'x'.repeat(7000) });
    expect(token.length).toBeGreaterThan(8192);
    expect(await verifier()(token)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { iss: 'https://other.example' }, { aud: [`${publicOrigin}/mcp`] }, { aud: `${publicOrigin}/mcp/` },
    { sub: '' }, { sub: 'x'.repeat(257) }, { sub: 'bad\u0000subject' }, { exp: 1 },
    { nbf: Math.floor(Date.now() / 1000) + 3600 }, { scope: ['cauce.read'] }, { scope: 'bad\tscope' },
    { scope: 'bad\nscope' }, { scope: 'bad"scope' }, { scope: 'bad\\scope' },
  ])('rejects invalid signed identity claims %#', async (override) => {
    const claims = { iss: config.issuer, aud: `${publicOrigin}/mcp`, sub: 'subject-valid',
      exp: Math.floor(Date.now() / 1000) + 60, ...override };
    expect(await verifier()(await signedToken(claims))).toBeUndefined();
  });

  it('rejects array audiences, unsupported algorithms, invalid token types, and forged signatures', async () => {
    const claims = { iss: config.issuer, aud: `${publicOrigin}/mcp`, sub: 'subject-valid', exp: Math.floor(Date.now() / 1000) + 60 };
    const arrayAudience = await signedToken({ ...claims, aud: [`${publicOrigin}/mcp`] });
    const wrongType = await signedToken(claims, { alg: 'RS256', kid: 'identity-key', typ: 'JWT' });
    const unsupportedAlgorithm = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: 'identity-key', typ: 'at+jwt' }).sign(new TextEncoder().encode('untrusted-test-key'));
    const forgedKey = await generateKeyPair('RS256');
    const forged = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'identity-key', typ: 'at+jwt' })
      .sign(forgedKey.privateKey);
    expect(await verifier()(arrayAudience)).toBeUndefined();
    expect(await verifier()(wrongType)).toBeUndefined();
    expect(await verifier()(unsupportedAlgorithm)).toBeUndefined();
    expect(await verifier()(forged)).toBeUndefined();
  });

  it('accepts ES256 tokens from the configured key set', async () => {
    const pair = await generateKeyPair('ES256');
    const ecJwk = { ...await exportJWK(pair.publicKey), kid: 'ec-identity-key', alg: 'ES256', use: 'sig' };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ keys: [ecJwk] })));
    const token = await new SignJWT({ iss: config.issuer, aud: `${publicOrigin}/mcp`, sub: 'ec-subject',
      exp: Math.floor(Date.now() / 1000) + 60 }).setProtectedHeader({ alg: 'ES256', kid: 'ec-identity-key', typ: 'at+jwt' }).sign(pair.privateKey);
    expect(await verifier()(token)).toMatchObject({ subject: 'ec-subject', issuer: config.issuer, scopes: [] });
  });
});
