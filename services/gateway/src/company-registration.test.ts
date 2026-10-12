import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGateway } from './app.js';
import { PasswordAuthProvider } from './password-auth.js';
import { MemoryConsoleUserStore } from './test-support/console-users.js';
import { fakePool, fakeRepository, noDeliveryWakes } from './test-support/gateway-doubles.js';

let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
beforeEach(async () => {
  vi.stubEnv('CAUCE_TRUSTED_PROXY_CIDRS', '127.0.0.1/32,172.18.0.0/16');
  app = await buildGateway({ pool: fakePool(), repository: fakeRepository(), deliveryWakeSubscriber: noDeliveryWakes,
    authProvider: new PasswordAuthProvider({ users: new MemoryConsoleUserStore(), signingKey: Buffer.alloc(32, 7) }) });
});
afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); });

async function attempt(remoteAddress: string, forwardedFor: string) {
  if (!app) throw new Error('Gateway fixture is not ready');
  return app.inject({ method: 'POST', url: '/v3/auth/register', remoteAddress,
    headers: { origin: 'http://localhost', 'x-forwarded-for': forwardedFor }, payload: {} });
}

describe('company registration client IP limits', () => {
  it('gives each forwarded client five attempts and rejects the sixth for fifteen minutes', async () => {
    for (const client of ['198.51.100.1', '198.51.100.2']) {
      for (let count = 0; count < 5; count++) expect((await attempt('172.18.0.2', client)).statusCode).toBe(400);
      const limited = await attempt('172.18.0.2', client);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: 'too_many_requests' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(899);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(900);
    }
  });

  it('does not let an untrusted client reset its limit with forged forwarding headers', async () => {
    for (let count = 0; count < 5; count++) {
      expect((await attempt('203.0.113.9', `198.51.100.${String(count + 1)}`)).statusCode).toBe(400);
    }
    expect((await attempt('203.0.113.9', '198.51.100.99')).statusCode).toBe(429);
    expect((await attempt('203.0.113.10', '198.51.100.99')).statusCode).toBe(400);
  });

  it('ignores earlier claimed hops even when the nearest forwarded client is private', async () => {
    for (let count = 0; count < 5; count++) {
      expect((await attempt('172.18.0.2', `198.51.100.${String(count + 1)}, 172.18.0.9`)).statusCode).toBe(400);
    }
    expect((await attempt('172.18.0.2', '198.51.100.99, 172.18.0.9')).statusCode).toBe(429);
    expect((await attempt('172.18.0.2', '198.51.100.99, 172.18.0.10')).statusCode).toBe(400);
  });
});
