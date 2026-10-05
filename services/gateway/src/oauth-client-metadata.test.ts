import { describe, expect, it, vi } from 'vitest';
import type { OAuthMetadataFetch } from './oauth-client-fetch.js';
import { OAUTH_CLIENT_HOST_PENDING_CAP, OAuthClients } from './oauth-client-metadata.js';

const id = 'https://client.example/metadata.json';
const doc = { client_id: id, client_name: 'Fixture client', redirect_uris: ['https://client.example/callback'],
  grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] };
const fetchDocument = (value: unknown, cacheControl?: string) => vi.fn(async () => ({ body: JSON.stringify(value),
  ...(cacheControl === undefined ? {} : { cacheControl }) }));

describe('CIMD client identity', () => {
  it('accepts public authentication offered alongside private authentication', async () => {
    const client = await new OAuthClients({ fetch: fetchDocument({ ...doc, token_endpoint_auth_method: 'private_key_jwt' }) }).resolve(id);
    expect(client.clientId).toBe(id);
    expect(Object.isFrozen(client.redirectUris)).toBe(true);
  });
  it.each([{ client_id: 'https://other.example/metadata.json' }, { redirect_uris: ['https://other.example/callback'] },
    { redirect_uris: ['http://client.example/callback'] }, { redirect_uris: ['https://client.example/callback?code=stolen'] },
    { token_endpoint_auth_methods_supported: ['private_key_jwt'] }, { response_types: ['token'] },
    { grant_types: ['refresh_token'] }, { client_name: '\u0000' }])('rejects metadata authority substitution %j', async (override) => {
    await expect(new OAuthClients({ fetch: fetchDocument({ ...doc, ...override }) }).resolve(id)).rejects.toThrow('invalid_client');
  });
  it('requires a configured exact origin for cross-origin redirect URIs', async () => {
    const clients = new OAuthClients({ fetch: fetchDocument({ ...doc, redirect_uris: ['https://callback.example/return'] }),
      additionalRedirectOrigins: ['https://callback.example'] });
    expect((await clients.resolve(id)).redirectUris).toEqual(['https://callback.example/return']);
  });
  it('deduplicates in-flight fetches and expires capped cached identity', async () => {
    let now = 0;
    const fetch = fetchDocument(doc, 'max-age=9999');
    const clients = new OAuthClients({ fetch, now: () => now });
    const [a, b] = await Promise.all([clients.resolve(id), clients.resolve(id)]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledOnce();
    now = 300_001;
    await clients.resolve(id);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('honors no-store and refuses oversized documents', async () => {
    const fetch = fetchDocument(doc, 'no-store');
    const clients = new OAuthClients({ fetch });
    await clients.resolve(id);
    await clients.resolve(id);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(new OAuthClients({ fetch: vi.fn(async () => ({ body: 'x'.repeat(16385) })) }).resolve(id)).rejects.toThrow('invalid_client');
  });
  it('caps in-flight resolutions per client host without starving other hosts', async () => {
    const hung: OAuthMetadataFetch = () => new Promise(() => { /* never settles: keeps the slot occupied */ });
    const clients = new OAuthClients({ fetch: hung });
    const warm = Array.from({ length: OAUTH_CLIENT_HOST_PENDING_CAP },
      (_, index) => clients.resolve(`https://client.example/metadata-${String(index)}.json`));
    await expect(clients.resolve('https://client.example/metadata-overflow.json')).rejects.toThrow('invalid_client');
    let otherHostSettled = false;
    const otherHost = clients.resolve('https://other.example/metadata.json');
    otherHost.then(() => { otherHostSettled = true; }, () => { otherHostSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(otherHostSettled).toBe(false);
    expect(warm).toHaveLength(OAUTH_CLIENT_HOST_PENDING_CAP);
  });
});
