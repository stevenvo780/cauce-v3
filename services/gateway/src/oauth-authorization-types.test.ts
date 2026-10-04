import { describe, expect, it } from 'vitest';
import { httpsUrl, oauthOrigin, scopes, secretHash } from './oauth-authorization-types.js';

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
});
