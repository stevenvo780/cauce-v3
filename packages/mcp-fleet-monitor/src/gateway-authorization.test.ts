import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayAuthorization, MAX_JWKS_BYTES, MCP_METADATA_PATH } from './gateway-authorization.js';
import { gatewayBridgeConfiguration, type GatewayAccessConfiguration } from './gateway-configuration.js';

const publicOrigin = 'https://mcp.example';
const oauth = { mode: 'oauth', issuer: 'https://auth.example/realm', jwksUri: 'https://auth.example/realm/jwks', subject: 'owner-fixture' } as const;
let key: CryptoKey;
let jwk: JWK;
const fetcher = vi.fn<typeof fetch>();

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
});
beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function token(overrides: Record<string, unknown> = {}, header = { alg: 'RS256', kid: 'fixture-key', typ: 'at+jwt' }): Promise<string> {
  return new SignJWT({ iss: oauth.issuer, aud: `${publicOrigin}/mcp`, sub: oauth.subject,
    exp: Math.floor(Date.now() / 1000) + 60, scope: 'cauce.read', ...overrides })
    .setProtectedHeader(header).sign(key);
}

describe('OAuth protected resource', () => {
  it('advertises the exact resource and trusted authorization server', () => {
    const authorization = createGatewayAuthorization(publicOrigin, oauth);
    expect(authorization.metadata).toEqual({
      resource: 'https://mcp.example/mcp', authorization_servers: [oauth.issuer], scopes_supported: ['cauce.read'],
      bearer_methods_supported: ['header'], resource_name: 'Cauce read-only MCP',
    });
    expect(authorization.challenge).toBe(`Bearer resource_metadata="${publicOrigin}${MCP_METADATA_PATH}", scope="cauce.read"`);
  });

  it('verifies signed access tokens and caches bounded HTTPS public-key reads', async () => {
    const authorization = createGatewayAuthorization(publicOrigin, oauth);
    const bearer = `Bearer ${await token()}`;
    expect(await authorization.authenticate(bearer)).toBe(true);
    expect(await authorization.authenticate(bearer)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(oauth.jwksUri);
    expect(options?.method).toBe('GET');
    expect(options?.redirect).toBe('error');
    expect(options?.credentials).toBe('omit');
    expect(new Headers(options?.headers).get('authorization')).toBeNull();
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { iss: 'https://other.example' }, { aud: 'https://gateway.example' },
    { aud: ['https://mcp.example/mcp', 'https://other.example'] }, { sub: 'another-user' },
    { exp: 1 }, { exp: undefined }, { nbf: 4_000_000_000 }, { scope: 'other' },
    { scope: 'prefix-cauce.read-suffix' }, { scope: ['cauce.read'] }, { scope: undefined },
  ])('rejects wrong authority, audience, user, time or scope %#', async (claims) => {
    expect(await createGatewayAuthorization(publicOrigin, oauth).authenticate(`Bearer ${await token(claims)}`)).toBe(false);
  });

  it('requires access-token type and a known signature key', async () => {
    const authorization = createGatewayAuthorization(publicOrigin, oauth);
    expect(await authorization.authenticate(`Bearer ${await token({}, { alg: 'RS256', kid: 'fixture-key', typ: 'JWT' })}`)).toBe(false);
    expect(await authorization.authenticate(`Bearer ${await token({}, { alg: 'RS256', kid: 'unknown-key', typ: 'at+jwt' })}`)).toBe(false);
  });

  it('rejects a forged signature even when the key identifier matches', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ iss: oauth.issuer, aud: `${publicOrigin}/mcp`, sub: oauth.subject, scope: 'cauce.read' })
      .setExpirationTime('1m').setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', typ: 'at+jwt' }).sign(other.privateKey);
    expect(await createGatewayAuthorization(publicOrigin, oauth).authenticate(`Bearer ${forged}`)).toBe(false);
  });

  it('accepts ES256 access tokens from the configured key set', async () => {
    const pair = await generateKeyPair('ES256');
    const publicKey = { ...await exportJWK(pair.publicKey), kid: 'ec-fixture', alg: 'ES256', use: 'sig' };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ keys: [publicKey] })));
    const signed = await new SignJWT({ iss: oauth.issuer, aud: `${publicOrigin}/mcp`, sub: oauth.subject, scope: 'cauce.read' })
      .setExpirationTime('1m').setProtectedHeader({ alg: 'ES256', kid: 'ec-fixture', typ: 'at+jwt' }).sign(pair.privateKey);
    expect(await createGatewayAuthorization(publicOrigin, oauth).authenticate(`Bearer ${signed}`)).toBe(true);
  });

  it('keeps the JWKS deadline active while reading a stalled body', async () => {
    fetcher.mockImplementationOnce(async (_url, options) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        options?.signal?.addEventListener('abort', () => { controller.error(new Error('fixture abort')); }, { once: true });
      },
    })));
    expect(await createGatewayAuthorization(publicOrigin, oauth).authenticate(`Bearer ${await token()}`)).toBe(false);
  }, 6000);

  it('rejects malformed, oversized and unsigned credentials without upstream key lookup', async () => {
    const authorization = createGatewayAuthorization(publicOrigin, oauth);
    for (const credential of ['', 'Basic private', 'Bearer malformed', `Bearer ${'a'.repeat(8193)}`, 'Bearer eyJhbGciOiJub25lIn0.e30.']) {
      expect(await authorization.authenticate(credential)).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['network', 'redirect', 'oversized', 'invalid'])('fails closed on %s JWKS errors', async (failure) => {
    fetcher.mockImplementationOnce(async () => {
      if (failure === 'network') throw new Error('private network details');
      if (failure === 'redirect') return new Response('secret', { status: 302, headers: { location: 'https://other.example' } });
      return new Response(failure === 'oversized' ? ' '.repeat(MAX_JWKS_BYTES + 1) : 'invalid');
    });
    expect(await createGatewayAuthorization(publicOrigin, oauth).authenticate(`Bearer ${await token()}`)).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not accept the configured gateway token as an OAuth credential', async () => {
    expect(await createGatewayAuthorization(publicOrigin, oauth).authenticate('Bearer gateway-fixture-token')).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('OAuth configuration', () => {
  const environment = {
    CAUCE_GATEWAY_ORIGIN: 'https://gateway.example', CAUCE_GATEWAY_BEARER_TOKEN: 'gateway-fixture',
    CAUCE_MCP_PUBLIC_ORIGIN: publicOrigin, CAUCE_MCP_TENANT_ID: 'TenantA',
    CAUCE_MCP_OAUTH_ISSUER: oauth.issuer, CAUCE_MCP_OAUTH_JWKS_URI: oauth.jwksUri, CAUCE_MCP_OAUTH_SUBJECT: oauth.subject,
  };

  it('defaults to OAuth and requires a configured authorized subject', () => {
    expect(gatewayBridgeConfiguration(environment).authentication).toEqual(oauth satisfies GatewayAccessConfiguration);
  });

  it.each([
    { CAUCE_MCP_AUTH_MODE: 'none' }, { CAUCE_MCP_OAUTH_SUBJECT: '' },
    { CAUCE_MCP_OAUTH_SUBJECT: '\nowner' }, { CAUCE_MCP_OAUTH_ISSUER: 'http://auth.example' },
    { CAUCE_MCP_OAUTH_ISSUER: 'https://secret@auth.example' }, { CAUCE_MCP_OAUTH_JWKS_URI: undefined },
    { CAUCE_MCP_OAUTH_JWKS_URI: 'https://auth.example/jwks?token=secret' },
  ])('rejects unsafe or missing OAuth configuration %#', (override) => {
    expect(() => gatewayBridgeConfiguration({ ...environment, ...override })).toThrow();
  });
});
