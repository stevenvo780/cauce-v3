import { describe, expect, it } from 'vitest';
import { clientRegistration, isRegisteredClientId, OAuthRegistrationLimiter, registrationDocument } from './oauth-client-registration.js';

describe('RFC 7591 public client registration', () => {
  it('keeps only enforced metadata, defaults to a public client and sanitizes the declared name', () => {
    const registration = clientRegistration({ redirect_uris: ['http://[::1]/cb', 'http://[::1]/cb'], client_name: ' ‮Cauce\u0000  oficial ', scope: 'x', jwks: {} });
    expect(registration).toEqual({ clientName: 'Cauce oficial', redirectUris: ['http://[::1]/cb'], grantTypes: ['authorization_code'] });
    expect(Object.isFrozen(registration.redirectUris)).toBe(true);
    expect(clientRegistration({ redirect_uris: ['https://a.example/cb'], client_name: '\u0007' }).clientName).toBeNull();
    expect(clientRegistration({ redirect_uris: ['https://a.example/cb'], client_name: 'x'.repeat(500) }).clientName).toHaveLength(100);
    expect(() => clientRegistration({ redirect_uris: ['https://a.example/cb'], client_name: 7 })).toThrow('invalid_client_metadata');
    expect(() => clientRegistration([])).toThrow('invalid_client_metadata');
  });
  it('publishes a document without secrets', () => {
    const document = registrationDocument({ clientId: 'cauce-dcr-00000000-0000-4000-8000-000000000000', issuedAt: 1, clientName: null,
      redirectUris: ['https://a.example/cb'], grantTypes: ['authorization_code', 'refresh_token'] });
    expect(document).toEqual({ client_id: 'cauce-dcr-00000000-0000-4000-8000-000000000000', client_id_issued_at: 1,
      redirect_uris: ['https://a.example/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  });
  it.each(['cauce-dcr-x', 'https://cauce-dcr-00000000-0000-4000-8000-000000000000', 'cauce-dcr-00000000-0000-4000-8000-000000000000x'])(
    'does not treat %s as a registered client id', (value) => { expect(isRegisteredClientId(value)).toBe(false); },
  );
  it('refills per address and bounds its memory', () => {
    let now = 0;
    const limiter = new OAuthRegistrationLimiter({ capacity: 2, refillMs: 1000, now: () => now });
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a'), limiter.take('b')]).toEqual([true, true, false, true]);
    now = 1000;
    expect([limiter.take('a'), limiter.take('a')]).toEqual([true, false]);
    for (let index = 0; index < 5000; index += 1) limiter.take(String(index));
    expect(limiter.retryAfterSeconds).toBe(1);
    expect(() => new OAuthRegistrationLimiter({ capacity: 0 })).toThrow();
  });
  it('defaults to a global budget of 60 registrations refilled one every 2 s', () => {
    let now = 0;
    const limiter = new OAuthRegistrationLimiter({ now: () => now });
    expect(Array.from({ length: 61 }, () => limiter.take('global')).filter(Boolean)).toHaveLength(60);
    expect(limiter.retryAfterSeconds).toBe(2);
    now = 1999;
    expect(limiter.take('global')).toBe(false);
    now = 3999;
    expect([limiter.take('global'), limiter.take('global')]).toEqual([true, false]);
  });
});
