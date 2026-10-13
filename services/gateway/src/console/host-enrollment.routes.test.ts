import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostRequestMessage, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../app.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';
import { fakePool, fakeRepository, noDeliveryWakes } from '../test-support/gateway-doubles.js';
import type { HostSetupPackager } from '../fleet/host-setup.js';
import { registerHostEnrollmentRoutes } from './host-enrollment.routes.js';

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

/** Answers every query as the enrolled identity of the host it names, so a valid proof reaches the transaction. */
function enrolledPool(keys: Record<string, string>) {
  const answer = vi.fn(async (_sql: string, params: unknown[] = []) => ({
    rows: [{ public_key: keys[String(params[0])], available: true, timeout_ms: 0 }], rowCount: 1 }));
  const connect = vi.fn(async () => ({ query: answer, on: vi.fn(), off: vi.fn(), release: vi.fn() }));
  return { pool: { query: answer, connect } as unknown as DatabasePool, connect };
}
function computer(host: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { host, privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}
function signed(host: string, privateKey: KeyObject, route: 'heartbeat' | 'setup') {
  const payload = route === 'setup' ? { action: 'package' }
    : { platform: 'linux', cli_version: '4.0.0', docker_version: null, status: 'reachable' };
  const packet = { company_id: 'north', host_id: host, issued_at: Date.now(), nonce: randomBytes(32).toString('hex'), payload, proof: '' };
  packet.proof = sign(null, Buffer.from(hostRequestMessage('POST', `/v3/fleet/hosts/${host}/${route}`, packet)), privateKey).toString('base64');
  return packet;
}

describe('signed host request quotas', () => {
  const north = computer('north-laptop'); const desk = computer('north-desk'); const forger = computer('north-laptop');
  let hosts: FastifyInstance | undefined;
  let connect: ReturnType<typeof enrolledPool>['connect'];
  beforeEach(async () => {
    const enrolled = enrolledPool({ [north.host]: north.publicKey, [desk.host]: desk.publicKey });
    connect = enrolled.connect;
    hosts = Fastify({ logger: false });
    registerHostEnrollmentRoutes(hosts, new PasswordAuthProvider({ users: new MemoryConsoleUserStore(), signingKey: Buffer.alloc(32, 7) }),
      enrolled.pool, [], { signerFingerprint: 'f'.repeat(64), build: () => ({ package: 'signed' }) } as unknown as HostSetupPackager);
    await hosts.ready();
  });
  afterEach(async () => { await hosts?.close(); hosts = undefined; });
  async function send(remoteAddress: string, route: 'heartbeat' | 'setup', packet: ReturnType<typeof signed>) {
    if (!hosts) throw new Error('host routes are not ready');
    return hosts.inject({ method: 'POST', url: `/v3/fleet/hosts/${packet.host_id}/${route}`, remoteAddress, payload: packet });
  }

  it('keeps a computer reporting and fetching its setup while 10 001 networks forge its proof', async () => {
    for (let network = 0; network <= 10_000; network++) {
      const route = network % 2 === 0 ? 'heartbeat' : 'setup';
      expect((await send(`2001:db8:${network.toString(16)}::1`, route, signed(north.host, forger.privateKey, route))).statusCode).toBe(403);
    }
    expect(connect).not.toHaveBeenCalled();
    expect((await send('2001:db8:ffff::1', 'heartbeat', signed(north.host, north.privateKey, 'heartbeat'))).json())
      .toEqual({ host_id: north.host, company_id: 'north', accepted: true });
    expect((await send('2001:db8:fffe::1', 'setup', signed(north.host, north.privateKey, 'setup'))).json()).toEqual({ package: 'signed' });
  }, 60_000);

  it('limits a computer that rotates its address once its own proof verifies', async () => {
    for (const route of ['heartbeat', 'setup'] as const) {
      for (let count = 0; count < 10; count++) {
        expect((await send(`198.51.100.${String(count)}`, route, signed(north.host, north.privateKey, route))).statusCode).toBe(200);
      }
      const limited = await send('198.51.100.200', route, signed(north.host, north.privateKey, route));
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: 'too_many_requests' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    }
    expect((await send('198.51.100.201', 'heartbeat', signed(desk.host, desk.privateKey, 'heartbeat'))).statusCode).toBe(200);
    expect(connect).toHaveBeenCalledTimes(21);
  });
});
