import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OAuthTokens } from './oauth-tokens.js';

const issuer = 'https://cauce.example';
const userId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
let now: number;
const create = () => new OAuthTokens({ issuer, resource: `${issuer}/mcp`, signingKey: privateKey, kid: 'fixture', now: () => now });
const input = { userId, grantId, scopes: ['cauce.read'] as const, expiresAt: 20_000 };

describe('local OAuth access tokens', () => {
  beforeEach(() => { now = 10_000_000; });
  it('verifies ES256 and exposes only the public key', () => {
    const tokens = create();
    const issued = tokens.issue(input);
    expect(tokens.verify(issued.token)).toEqual(issued.identity);
    expect(issued.identity.expiresAt).toBe(10_300);
    expect(tokens.jwks().keys[0]).toMatchObject({ alg: 'ES256', use: 'sig', kid: 'fixture' });
    expect(tokens.jwks().keys[0]).not.toHaveProperty('d');
  });
  it('caps access expiry at grant expiry and rejects expired tokens', () => {
    const tokens = create();
    const issued = tokens.issue({ ...input, expiresAt: 10_001 });
    expect(issued.identity.expiresAt).toBe(10_001);
    now += 1_000;
    expect(tokens.verify(issued.token)).toBeUndefined();
  });
  it.each([{ sub: 'email@example.test' }, { aud: `${issuer}/other` }, { iss: 'https://other.example' },
    { gid: 'not-a-uuid' }, { exp: 10_400 }, { iat: 10_001 }, { scope: 'cauce.admin' }])(
    'rejects invalid signed claims %j', (override) => {
      const tokens = create();
      const original = tokens.issue(input).token.split('.');
      const payload: Record<string, unknown> = JSON.parse(Buffer.from(original[1] ?? '', 'base64url').toString()) as Record<string, unknown>;
      const body = `${original[0] ?? ''}.${Buffer.from(JSON.stringify({ ...payload, ...override })).toString('base64url')}`;
      const signature = sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      expect(tokens.verify(`${body}.${signature}`)).toBeUndefined();
    },
  );
  it('rejects tampering, unsigned tokens and nonfinite expiry', () => {
    const tokens = create();
    const token = tokens.issue(input).token;
    expect(tokens.verify(`${token}a`)).toBeUndefined();
    const unsignedToken = [Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'), Buffer.from(JSON.stringify({})).toString('base64url'), ''].join('.');
    expect(tokens.verify(unsignedToken)).toBeUndefined();
    expect(() => tokens.issue({ ...input, expiresAt: NaN })).toThrow();
  });
  it('requires an injected P-256 private key and a TTL no larger than five minutes', () => {
    expect(() => new OAuthTokens({ issuer, resource: `${issuer}/mcp`, signingKey: privateKey, kid: 'x', ttlSeconds: 301 })).toThrow();
    expect(() => new OAuthTokens({ issuer, resource: `${issuer}/wrong`, signingKey: privateKey, kid: 'x' })).toThrow();
  });
});
