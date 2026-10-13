import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { hashPassword } from './password.js';
import { LoginThrottle, PasswordAuthProvider, passwordWork, registerPasswordAuth } from './password-auth.js';
import type { ConsoleUser } from './console-users.js';
import { MemoryConsoleUserStore } from './test-support/console-users.js';

const PASSWORD = 'synthetic-login-passphrase';
async function makeUser(overrides: Partial<ConsoleUser> = {}): Promise<ConsoleUser> {
  return { id: randomUUID(), email: 'owner@example.test', display_name: 'Owner', role: 'operator',
    tenant_id: 'test-company', alias: 'owner', active: true, password_changed_at: 0,
    password_hash: await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 }), ...overrides };
}
async function fixture(options: { user?: ConsoleUser; throttle?: LoginThrottle; addressThrottle?: LoginThrottle } = {}) {
  let now = 0;
  const users = new MemoryConsoleUserStore([options.user ?? await makeUser()]);
  const provider = new PasswordAuthProvider({ users, signingKey: Buffer.alloc(32, 7), now: () => now,
    ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
    ...(options.addressThrottle === undefined ? {} : { addressThrottle: options.addressThrottle }) });
  const app = Fastify();
  registerPasswordAuth(app, provider);
  return { app, users, advance(ms: number) { now += ms; },
    login(email: string, password: string, remoteAddress = '127.0.0.1') {
      return app.inject({ method: 'POST', url: '/v3/auth/login', remoteAddress,
        headers: { origin: 'http://localhost' }, payload: { email, password } });
    } };
}

describe('concurrent login admission', () => {
  it('rejects the fifth login from one IP before the scrypt queue and admits another IP', async () => {
    const user = await makeUser();
    const test = await fixture({ user });
    for (let index = 0; index < 6; index++) {
      test.users.put({ ...user, id: randomUUID(), email: `owner-${String(index)}@example.test` });
    }
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const occupied = [passwordWork.run(() => held, 'login'), passwordWork.run(() => held, 'login')];
    const work = vi.spyOn(passwordWork, 'run');
    const logins = Array.from({ length: 4 }, (_, index) =>
      test.login(`owner-${String(index)}@example.test`, PASSWORD, '203.0.113.7').then(response => response));
    let refused: Awaited<ReturnType<typeof test.login>> | undefined;
    const extra: Promise<unknown>[] = [];
    try {
      await vi.waitFor(() => { expect(work).toHaveBeenCalledTimes(4); });
      extra.push(test.login('owner-4@example.test', PASSWORD, '203.0.113.7').then(response => { refused = response; }));
      await vi.waitFor(() => { expect(refused?.statusCode).toBe(429); });
      expect(Number(refused?.headers['retry-after'])).toBeGreaterThan(0);
      expect(work).toHaveBeenCalledTimes(4);
      const independent = test.login('owner-5@example.test', PASSWORD, '198.51.100.1').then(response => response);
      extra.push(independent);
      await vi.waitFor(() => { expect(work).toHaveBeenCalledTimes(5); });
      release();
      expect((await independent).statusCode).toBe(200);
      expect((await Promise.all(logins)).map(response => response.statusCode)).toEqual([200, 200, 200, 200]);
      expect((await test.login('owner-4@example.test', PASSWORD, '203.0.113.7')).statusCode).toBe(200);
    } finally {
      release(); await Promise.all([...occupied, ...logins, ...extra]);
      work.mockRestore(); await test.app.close();
    }
  });

  it('releases both reservations after a user lookup fails', async () => {
    const test = await fixture({ user: await makeUser({ email: 'owner@example.test' }),
      throttle: new LoginThrottle(1, 60_000), addressThrottle: new LoginThrottle(1, 60_000) });
    const lookup = vi.spyOn(test.users, 'findByEmail').mockRejectedValueOnce(new Error('lookup unavailable'));
    try {
      expect((await test.login('owner@example.test', PASSWORD)).statusCode).toBe(500);
      expect((await test.login('owner@example.test', PASSWORD)).statusCode).toBe(200);
    } finally { lookup.mockRestore(); await test.app.close(); }
  });

  it('starts the failure window when a slow lookup finishes', async () => {
    const test = await fixture({ user: await makeUser({ email: 'owner@example.test' }), throttle: new LoginThrottle(1, 60_000) });
    let release: () => void = () => undefined;
    const held = new Promise<undefined>(resolve => { release = () => { resolve(undefined); }; });
    const lookup = vi.spyOn(test.users, 'findByEmail').mockImplementation(() => held);
    const login = test.login('slow@example.test', 'wrong');
    try {
      await vi.waitFor(() => { expect(lookup).toHaveBeenCalledTimes(1); });
      test.advance(120_000); release();
      expect((await login).statusCode).toBe(401);
      const refused = await test.login('slow@example.test', 'wrong');
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('60');
    } finally { release(); await login; lookup.mockRestore(); await test.app.close(); }
  });

  it.each(['address', 'email'] as const)('limits pending attempts by %s before looking up users', async (dimension) => {
    const test = await fixture({ user: await makeUser({ email: 'owner@example.test' }),
      throttle: new LoginThrottle(3, 60_000), addressThrottle: new LoginThrottle(3, 60_000) });
    let release: () => void = () => undefined;
    const held = new Promise<undefined>(resolve => { release = () => { resolve(undefined); }; });
    const find = test.users.findByEmail.bind(test.users);
    const lookup = vi.spyOn(test.users, 'findByEmail').mockImplementation(email => email === 'owner@example.test' ? find(email) : held);
    const flood = Array.from({ length: 10 }, (_, index) => test.login(
      dimension === 'email' ? 'missing@example.test' : `missing-${String(index)}@example.test`, 'wrong',
      dimension === 'address' ? '203.0.113.7' : `203.0.113.${String(index + 10)}`));
    try {
      await vi.waitFor(() => { expect(lookup).toHaveBeenCalledTimes(3); });
      expect((await test.login('owner@example.test', PASSWORD, '198.51.100.1')).statusCode).toBe(200);
      release();
      const responses = await Promise.all(flood);
      expect(responses.filter(response => response.statusCode === 401)).toHaveLength(3);
      const refused = responses.filter(response => response.statusCode === 429);
      expect(refused).toHaveLength(7);
      for (const response of refused) expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    } finally { release(); await Promise.all(flood); lookup.mockRestore(); await test.app.close(); }
  });

  it('queues real logins while background derivations fill their own queue', async () => {
    const test = await fixture({ user: await makeUser({ email: 'owner@example.test' }) });
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const registrations = Array.from({ length: 17 }, () => passwordWork.run(() => held));
    try {
      const logins = await Promise.all(Array.from({ length: 5 }, (_, index) =>
        test.login('owner@example.test', PASSWORD, `198.51.100.${String(index + 1)}`)));
      expect(logins.map(response => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
    } finally { release(); await Promise.all(registrations); await test.app.close(); }
  });
});
