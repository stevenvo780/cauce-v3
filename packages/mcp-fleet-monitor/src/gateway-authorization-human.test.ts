import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createHumanGatewayAuthorization } from './gateway-authorization.js';

const origin = 'https://mcp.example';
const config = { issuer: 'https://issuer.example', jwksUri: 'https://issuer.example/jwks' };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { keys = await generateKeyPair('ES256'); });
afterEach(() => { vi.unstubAllGlobals(); });
async function signed(subject: string, scope = 'cauce.read') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [{
    ...await exportJWK(keys.publicKey), kid: 'human-fixture', alg: 'ES256',
  }] }))));
  return `Bearer ${await new SignJWT({ scope, tenant_id: 'untrusted', operator_id: 'untrusted' })
    .setProtectedHeader({ alg: 'ES256', kid: 'human-fixture', typ: 'at+jwt' })
    .setIssuer(config.issuer).setAudience(`${origin}/mcp`).setSubject(subject)
    .setExpirationTime('1m').sign(keys.privateKey)}`;
}
it('returns the verified identity per request without accepting authority claims', async () => {
  const authorization = createHumanGatewayAuthorization(origin, config);
  const first = await authorization.authenticateIdentity(await signed('human-a'));
  const second = await authorization.authenticateIdentity(await signed('human-b'));
  expect(first).toMatchObject({ kind: 'oauth', subject: 'human-a', issuer: config.issuer, scopes: ['cauce.read'] });
  expect(second).toMatchObject({ subject: 'human-b' });
  expect(Object.keys(first ?? {}).sort()).toEqual(['audience', 'expiresAt', 'issuer', 'kind', 'scopes', 'subject']);
  expect(Object.isFrozen(first)).toBe(true);
});
it('does not turn valid authentication without scopes into a read grant', async () => {
  const identity = await createHumanGatewayAuthorization(origin, config).authenticateIdentity(await signed('human-a', ''));
  expect(identity?.scopes).toEqual([]);
});
it('rejects malformed input without a human identity', async () => {
  const authorization = createHumanGatewayAuthorization(origin, config);
  for (const header of ['', 'Basic fixture', 'Bearer malformed']) {
    expect(await authorization.authenticateIdentity(header)).toBeUndefined();
  }
});
