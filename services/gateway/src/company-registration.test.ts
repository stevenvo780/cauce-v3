import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { buildGateway } from './app.js';
import { configuredHourlyRegistrations } from './company-registration.js';
import { PasswordAuthProvider, passwordWork } from './password-auth.js';
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
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('AS in_use')) {
      const [email, slug] = values as string[];
      return { rows: [{ in_use: emails.has(email ?? '') || slugs.has(slug ?? '') }] };
    }
    return { rows: [{ '?column?': 1 }] };
  };
  return { pool: Object.assign(fakePool(), { connect: async () => client, query }) as unknown as DatabasePool, hashes };
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
    const register = (email: string, slug: string, remoteAddress = `198.51.100.${String(++address % 250)}`) => app.inject({ method: 'POST', url: '/v3/auth/register',
      remoteAddress, headers: { origin: 'http://localhost' },
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

  it('rejects a concurrent burst by IP before spending another clients global budget', async () => {
    const { register } = await open({ CAUCE_REGISTRATION_HOURLY_LIMIT: '6' });
    const flood = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      register(`burst-${String(index)}@example.test`, `burst-${String(index)}`, '203.0.113.7')));
    expect(flood.filter(response => response.statusCode === 201)).toHaveLength(5);
    const refused = flood.filter(response => response.statusCode === 429);
    expect(refused).toHaveLength(5);
    for (const response of refused) expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect((await register('independent@example.test', 'independent')).statusCode).toBe(201);
  });

  it('limits concurrent email attempts across IPs before the global budget', async () => {
    const { register } = await open({ CAUCE_REGISTRATION_HOURLY_LIMIT: '6' });
    const flood = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      register('burst@example.test', `burst-${String(index)}`)));
    expect(flood.filter(response => response.statusCode === 201)).toHaveLength(1);
    expect(flood.filter(response => response.statusCode === 409)).toHaveLength(4);
    const refused = flood.filter(response => response.statusCode === 429);
    expect(refused).toHaveLength(5);
    for (const response of refused) expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect((await register('independent@example.test', 'independent')).statusCode).toBe(201);
  });

  it('returns the hourly reservation when no password work can be admitted', async () => {
    const { register, hashes } = await open({ CAUCE_REGISTRATION_HOURLY_LIMIT: '2' });
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const occupied = Array.from({ length: 17 }, () => passwordWork.run(() => held));
    try {
      for (let index = 0; index < 3; index++) {
        const response = await register(`saturated-${String(index)}@example.test`, `saturated-${String(index)}`);
        expect(response.statusCode).toBe(429);
        expect(response.headers['retry-after']).toBe('5');
      }
      expect(hashes).toEqual([]);
    } finally { release(); await Promise.all(occupied); }
    expect((await register('independent@example.test', 'independent')).statusCode).toBe(201);
  });

  it('returns 429 and the global reservation when a saturated login queue delays registration for ten seconds', async () => {
    const { register, hashes } = await open({ CAUCE_REGISTRATION_HOURLY_LIMIT: '1' });
    await gateway?.ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const occupied = Array.from({ length: 18 }, () => passwordWork.run(() => held, 'login'));
    const work = vi.spyOn(passwordWork, 'run');
    let refused: Awaited<ReturnType<typeof register>> | undefined;
    const waiting = register('waiting@example.test', 'waiting').then(response => { refused = response; });
    try {
      await vi.waitFor(() => { expect(work).toHaveBeenCalledTimes(1); });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refused?.statusCode).toBe(429);
      expect(refused?.headers['retry-after']).toBe('5');
      expect(hashes).toEqual([]);
    } finally {
      release(); await Promise.all([...occupied, waiting]);
      work.mockRestore(); vi.useRealTimers();
    }
    expect((await register('independent@example.test', 'independent')).statusCode).toBe(201);
    expect(hashes).toHaveLength(1);
  });

  it('returns a saturated reservation to its original hour after the next window opens', async () => {
    const { register, hashes } = await open({ CAUCE_REGISTRATION_HOURLY_LIMIT: '1' });
    if (!gateway) throw new Error('Gateway fixture is not ready');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    let releaseWork: () => void = () => undefined;
    let releaseResponse: () => void = () => undefined;
    let markSaturated: () => void = () => undefined;
    const heldWork = new Promise<void>(resolve => { releaseWork = resolve; });
    const heldResponse = new Promise<void>(resolve => { releaseResponse = resolve; });
    const saturated = new Promise<void>(resolve => { markSaturated = resolve; });
    gateway.addHook('onSend', async (request, reply, payload) => {
      if (request.ip === '203.0.113.11' && reply.statusCode === 429) {
        markSaturated();
        await heldResponse;
      }
      return payload;
    });
    const occupied = Array.from({ length: 17 }, () => passwordWork.run(() => heldWork));
    const previous = register('previous@example.test', 'previous', '203.0.113.11').then(response => response);
    try {
      await expect(Promise.race([saturated.then(() => 'held'), previous.then(response => response.statusCode)])).resolves.toBe('held');
      expect(hashes).toEqual([]);
      releaseWork();
      await Promise.all(occupied);
      clock.mockReturnValue(3_601_000);
      expect((await register('current@example.test', 'current')).statusCode).toBe(201);
      releaseResponse();
      const refused = await previous;
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('5');
      await new Promise<void>(resolve => { setImmediate(resolve); });
      const limited = await register('next@example.test', 'next');
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('3600');
      expect(hashes).toHaveLength(1);
    } finally {
      releaseWork(); releaseResponse();
      try { await Promise.all([...occupied, previous]); }
      finally { clock.mockRestore(); }
    }
  });

  it('answers a taken email and a taken slug with one body without another derivation', async () => {
    const { register, hashes } = await open();
    expect((await register('dueno@example.test', 'acme')).statusCode).toBe(201);
    const email = await register('dueno@example.test', 'otra-empresa');
    const slug = await register('otra@example.test', 'acme');
    expect([email.statusCode, slug.statusCode]).toEqual([409, 409]);
    expect(email.body).toBe(slug.body);
    expect(email.json()).toEqual({ error: 'conflict',
      message: 'No se pudo completar el registro: el correo o el identificador de empresa ya están en uso.' });
    expect(hashes).toHaveLength(1);
    for (const hash of hashes) expect(hash).toMatch(/^\$scrypt\$n=32768,r=8,p=1\$/u);
  });

  it('answers a persisted duplicate before limiting new registrations from a repeated email', async () => {
    const { register } = await open();
    expect((await register('dueno@example.test', 'acme')).statusCode).toBe(201);
    for (let count = 1; count < 5; count++) expect((await register('dueno@example.test', `acme-${String(count)}`)).statusCode).toBe(409);
    for (let count = 1; count <= 5; count++) expect((await register('nadie@example.test', 'acme')).statusCode).toBe(409);
    expect((await register('dueno@example.test', 'libre')).statusCode).toBe(409);
    const limited = await register('nadie@example.test', 'libre');
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toBe(JSON.stringify({ error: 'too_many_requests', message: 'Demasiados registros. Intenta más tarde.' }));
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(899);
    expect((await register('nadie@example.test', 'acme')).statusCode).toBe(409);
    expect((await register('otra@example.test', 'libre')).statusCode).toBe(201);
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
    vi.stubEnv('CAUCE_REGISTRATION_HOURLY_LIMIT', undefined);
    expect(configuredHourlyRegistrations()).toBe(20);
    vi.unstubAllEnvs();
    expect(configuredHourlyRegistrations('0')).toBe(0);
    expect(configuredHourlyRegistrations(' 30 ')).toBe(30);
    for (const value of ['', '-1', '1.5', 'veinte', '1000000']) expect(() => configuredHourlyRegistrations(value)).toThrow(/CAUCE_REGISTRATION_HOURLY_LIMIT/u);
  });
});
