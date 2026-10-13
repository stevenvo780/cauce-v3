import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '../app.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';
import { fakePool, fakeRepository, noDeliveryWakes } from '../test-support/gateway-doubles.js';

let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
beforeEach(async () => {
  vi.stubEnv('CAUCE_TRUSTED_PROXY_CIDRS', '127.0.0.1/32,172.18.0.0/16');
  app = await buildGateway({ pool: fakePool(), repository: fakeRepository(), deliveryWakeSubscriber: noDeliveryWakes,
    authProvider: new PasswordAuthProvider({ users: new MemoryConsoleUserStore(), signingKey: Buffer.alloc(32, 7) }) });
});
afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); });

async function claim(remoteAddress: string, forwardedFor: string) {
  if (!app) throw new Error('Gateway fixture is not ready');
  return app.inject({ method: 'POST', url: '/v3/fleet/hosts/enrollments/invalid-id/claim', remoteAddress,
    headers: { 'x-forwarded-for': forwardedFor }, payload: {} });
}

async function signedHostRequest(remoteAddress: string, path: string) {
  if (!app) throw new Error('Gateway fixture is not ready');
  return app.inject({ method: 'POST', url: `/v3/fleet/hosts/${path}`, remoteAddress, payload: {} });
}

describe('host enrollment client IP limits', () => {
  it('limits signed heartbeats and setup requests per client before verifying them', async () => {
    for (let count = 0; count < 120; count++) {
      expect((await signedHostRequest('198.51.100.7', `north-host_${String(count % 3)}/heartbeat`)).statusCode).toBe(400);
    }
    for (const path of ['north-other/heartbeat', 'north-other/setup']) {
      const limited = await signedHostRequest('198.51.100.7', path);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: 'too_many_requests' });
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    }
    expect((await signedHostRequest('198.51.100.8', 'north-other/heartbeat')).statusCode).toBe(400);
  });

  it('gives each trusted-proxy client twenty claims and rejects the next for one minute', async () => {
    for (const client of ['198.51.100.1', '198.51.100.2']) {
      for (let count = 0; count < 20; count++) expect((await claim('172.18.0.2', client)).statusCode).toBe(400);
      const limited = await claim('172.18.0.2', client);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: 'too_many_requests' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(59);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    }
  });

  it('keeps forged forwarding headers from bypassing the direct-client claim limit', async () => {
    for (let count = 0; count < 20; count++) {
      expect((await claim('203.0.113.9', `198.51.100.${String(count + 1)}`)).statusCode).toBe(400);
    }
    expect((await claim('203.0.113.9', '198.51.100.99')).statusCode).toBe(429);
    expect((await claim('203.0.113.10', '198.51.100.99')).statusCode).toBe(400);
  });
});
