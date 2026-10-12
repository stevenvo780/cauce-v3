import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { buildGateway } from './app.js';
import { configuredHourlyRegistrations } from './company-registration.js';
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

  it('groups IPv6 clients by /64 so rotating the interface identifier does not reset the limit', async () => {
    for (let count = 0; count < 5; count++) {
      expect((await attempt('172.18.0.2', `2001:db8:1:2::${count.toString(16)}1`)).statusCode).toBe(400);
    }
    expect((await attempt('172.18.0.2', '2001:db8:1:2:ffff::9')).statusCode).toBe(429);
    expect((await attempt('172.18.0.2', '2001:db8:1:3::1')).statusCode).toBe(400);
  });
});

/** A registration database: unique email and slug, as `cauce_register_company` enforces them. */
function registrationPool() {
  const emails = new Set<string>(); const slugs = new Set<string>(); const hashes: string[] = [];
  const client = {
    on: () => undefined, off: () => undefined, release: () => undefined,
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('pg_settings')) return { rows: [{ timeout_ms: 0 }] };
      if (!sql.includes('cauce_register_company')) return { rows: [] };
      const [email, , hash, slug] = values as string[];
      hashes.push(hash ?? '');
      if (emails.has(email ?? '') || slugs.has(slug ?? '')) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      emails.add(email ?? ''); slugs.add(slug ?? '');
      return { rows: [{ human_id: '00000000-0000-4000-8000-000000000001', tenant_id: `hub-${slug ?? ''}`, actor_alias: 'owner' }] };
    },
  };
  return { pool: Object.assign(fakePool(), { connect: async () => client }) as unknown as DatabasePool, hashes };
}

describe('public company registration', () => {
  let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let address = 0;
  afterEach(async () => { await gateway?.close(); gateway = undefined; vi.unstubAllEnvs(); });

  async function open(env: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const database = registrationPool();
    gateway = await buildGateway({ pool: database.pool, repository: fakeRepository(), deliveryWakeSubscriber: noDeliveryWakes,
      authProvider: new PasswordAuthProvider({ users: new MemoryConsoleUserStore(), signingKey: Buffer.alloc(32, 7) }) });
    const app = gateway;
    const register = (email: string, slug: string) => app.inject({ method: 'POST', url: '/v3/auth/register',
      remoteAddress: `198.51.100.${String(++address % 250)}`, headers: { origin: 'http://localhost' },
      payload: { email, name: 'Dueña', password: 'contraseña-larga-1', company: { name: 'Empresa', slug } } });
    return { register, hashes: database.hashes };
  }

  it('caps registrations across every client address and rejects the sixth in the window', async () => {
    const { register } = await open({ CAUCE_REGISTRATION_HOURLY_LIMIT: '5' });
    for (let count = 1; count <= 5; count++) {
      expect((await register(`owner${String(count)}@example.test`, `empresa-${String(count)}`)).statusCode).toBe(201);
    }
    const limited = await register('owner6@example.test', 'empresa-6');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'too_many_requests', message: 'Demasiados registros. Intenta más tarde.' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(3_500);
  });

  it('answers a taken email and a taken slug with one body after the same derivation', async () => {
    const { register, hashes } = await open();
    expect((await register('dueno@example.test', 'acme')).statusCode).toBe(201);
    const email = await register('dueno@example.test', 'otra-empresa');
    const slug = await register('otra@example.test', 'acme');
    expect([email.statusCode, slug.statusCode]).toEqual([409, 409]);
    expect(email.body).toBe(slug.body);
    expect(email.json()).toEqual({ error: 'conflict',
      message: 'No se pudo completar el registro: el correo o el identificador de empresa ya están en uso.' });
    expect(hashes).toHaveLength(3);
    for (const hash of hashes) expect(hash).toMatch(/^\$scrypt\$n=32768,r=8,p=1\$/u);
  });

  it('refuses reserved slugs, the platform ones and those the operator holds back, without deriving', async () => {
    const { register, hashes } = await open({ CAUCE_RESERVED_COMPANY_SLUGS: 'praxis,humanizar' });
    for (const slug of ['praxis', 'humanizar', 'admin', 'platform', 'cauce', 'www']) {
      const refused = await register(`${slug}@example.test`, slug);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'conflict' });
    }
    expect(hashes).toEqual([]);
    expect((await register('libre@example.test', 'praxis-labs')).statusCode).toBe(201);
  });

  it('rejects a slug outside the console form language with a Spanish message', async () => {
    const { register, hashes } = await open();
    for (const slug of ['acme_corp', 'a', 'Acme', '1acme', 'a'.repeat(64)]) {
      const refused = await register('dueno@example.test', slug);
      expect(refused.statusCode).toBe(400);
      expect(refused.json<{ message: string }>().message).toContain('identificador de empresa');
    }
    expect(hashes).toEqual([]);
  });

  it('reads the hourly cap from configuration and fails closed on a malformed value', () => {
    expect(configuredHourlyRegistrations('0')).toBe(0);
    expect(configuredHourlyRegistrations(' 30 ')).toBe(30);
    for (const value of ['', '-1', '1.5', 'veinte', '1000000']) expect(() => configuredHourlyRegistrations(value)).toThrow(/CAUCE_REGISTRATION_HOURLY_LIMIT/u);
  });
});
