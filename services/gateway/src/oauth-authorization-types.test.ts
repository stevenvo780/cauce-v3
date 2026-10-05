import { describe, expect, it } from 'vitest';
import { httpsUrl, oauthOrigin, redirectMatches, redirectUrl, scopes, secretHash } from './oauth-authorization-types.js';

describe('OAuth boundary values', () => {
  it('deduplicates only supported scopes and freezes them', () => {
    const result = scopes('cauce.read cauce.publish cauce.read');
    expect(result).toEqual(['cauce.read', 'cauce.publish']);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each(['', 'cauce.admin', ' cauce.read', 'cauce.read ', 'cauce.read\tcauce.publish', null])(
    'rejects invalid scopes %s', (value) => { expect(() => scopes(value)).toThrow('invalid_scope'); },
  );
  it.each(['http://client.example/doc', 'https://user@client.example/doc', 'https://client.example:444/doc',
    'https://client.example/doc#fragment', 'https://CLIENT.example/doc', 'https://client.example/doc?key=x']) (
    'rejects noncanonical metadata URL %s', (value) => { expect(() => httpsUrl(value)).toThrow(); },
  );
  it('accepts an exact HTTPS resource and explicit redirect query', () => {
    expect(httpsUrl('https://client.example/doc').pathname).toBe('/doc');
    expect(httpsUrl('https://client.example/callback?route=a', true).search).toBe('?route=a');
    expect(oauthOrigin('https://cauce.example')).toBe('https://cauce.example');
    expect(() => oauthOrigin('https://cauce.example/path')).toThrow();
  });
  it('stores a stable digest instead of a raw secret', () => {
    expect(secretHash('opaque')).toMatch(/^[a-f0-9]{64}$/u);
    expect(secretHash('opaque')).not.toBe(secretHash('opaque2'));
  });
  it.each(['http://127.0.0.1:33418/', 'http://localhost/callback', 'http://[::1]:8080/cb', 'https://app.example:8443/cb?route=a'])(
    'accepts HTTPS and loopback redirect %s', (value) => { expect(redirectUrl(value).href).toBe(value); },
  );
  it.each(['http://app.example/cb', 'http://127.0.0.2/cb', 'https://app.example/cb#x', 'https://app.example/cb?code=x',
    'https://u@app.example/cb', 'custom://cb', 'http://LOCALHOST/cb'])(
    'rejects redirect %s', (value) => { expect(() => redirectUrl(value)).toThrow(); },
  );
  it('matches loopback redirects regardless of port and everything else exactly', () => {
    const registered = ['http://127.0.0.1/callback', 'http://[::1]:1/cb?x=1', 'https://app.example/cb'];
    expect(redirectMatches(registered, 'http://127.0.0.1:61234/callback')).toBe(true);
    expect(redirectMatches(registered, 'http://[::1]:9/cb?x=1')).toBe(true);
    expect(redirectMatches(registered, 'https://app.example/cb')).toBe(true);
    for (const value of ['http://localhost:61234/callback', 'http://127.0.0.1:61234/other', 'http://[::1]:9/cb',
      'https://app.example:444/cb', 'https://app.example/cb/']) expect(redirectMatches(registered, value)).toBe(false);
  });
});
