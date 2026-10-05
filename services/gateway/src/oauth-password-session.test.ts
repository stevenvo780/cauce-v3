import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { PasswordAuthProvider, signConsoleSession } from './password-auth.js';
import { hashPassword } from './password.js';
import { MemoryConsoleUserStore } from './test-support/console-users.js';
import type { ConsoleUser } from './console-users.js';
import { createConsoleCredentialStamp } from './console-credential-stamp.js';
import { createOAuthPasswordSession } from './oauth-password-session.js';

const key = Buffer.alloc(32, 7);
const userId = '11111111-1111-4111-8111-111111111111';
const now = 10_000_500;
const request = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie }, url: '/oauth/continue' }) as FastifyRequest;
const token = (override: Record<string, unknown> = {}) => signConsoleSession(key, {
  iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: userId, sid: 's'.repeat(36), csrf: 'c'.repeat(43),
  iat: 10_000, exp: 11_000, ...override,
});
async function fixture(passwordChangedAt = 0) {
  const user: ConsoleUser = { id: userId, email: 'fixture@example.test', display_name: 'Fixture', role: 'operator',
    tenant_id: 'Steven', alias: 'kant', active: true, password_changed_at: passwordChangedAt,
    password_hash: await hashPassword('fixture-password', { cost: 1024, blockSize: 8, parallelism: 1 }) };
  const users = new MemoryConsoleUserStore([user]);
  const fallbackCall = vi.fn();
  const provider = new PasswordAuthProvider({ users, signingKey: key, now: () => now,
    fallback: { name: 'fixture-machine', mode: 'production', authenticateHttp: fallbackCall, authenticateHello: fallbackCall } });
  return { user, users, provider, fallbackCall, read: createOAuthPasswordSession({ provider }) };
}

describe('OAuth human session uses real PasswordAuth', () => {
  it('preserves the original verified stamp and accepts a login in the password-change second', async () => {
    const fake = await fixture(10_000_250);
    const app = Fastify();
    app.post('/login', (req, reply) => fake.provider.login(req, reply));
    try {
      const login = await app.inject({ method: 'POST', url: '/login', payload: { email: fake.user.email, password: 'fixture-password' } });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const original = await fake.provider.verifiedConsoleSession(request(cookie));
      expect(original?.credentialStamp).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const verified = await fake.read(request(cookie));
      expect(verified).toMatchObject({ userId, credentialStamp: original?.credentialStamp });
    } finally { await app.close(); }
  });
  it('requires renewal of a legacy cookie instead of sealing the current credential', async () => {
    const fake = await fixture();
    await expect(fake.read(request(`__Host-cauce_session=${token()}`))).rejects.toThrow('access_denied');
  });
  it('accepts a valid console session with a stable UUID', async () => {
    const fake = await fixture();
    expect(await fake.read(request(`__Host-cauce_session=${token({ credential_stamp: createConsoleCredentialStamp(key, { userId, passwordHash: fake.user.password_hash, passwordChangedAtUs: String(fake.user.password_changed_at * 1000) }) })}`))).toMatchObject({ userId, issuedAt: 10_000, expiresAt: 11_000 });
    expect(fake.fallbackCall).not.toHaveBeenCalled();
  });
  it.each([undefined, 'other=fixture', '__Host-cauce_session=invalid',
    `__Host-cauce_session=${token()}; __Host-cauce_session=${token()}`])('never converts absent, invalid or duplicate cookies to machine identity', async (cookie) => {
    const fake = await fixture();
    await expect(fake.read(request(cookie))).rejects.toThrow('access_denied');
    expect(fake.fallbackCall).not.toHaveBeenCalled();
  });
  it.each([{ sub: 'fixture@example.test' }, { iat: 10_001 }, { exp: 10_000 }])('rejects invalid signed identity or time %j', async (override) => {
    const fake = await fixture();
    await expect(fake.read(request(`__Host-cauce_session=${token(override)}`))).rejects.toThrow('access_denied');
  });
  it('rechecks account disablement without trusting the signed cookie', async () => {
    const fake = await fixture();
    vi.spyOn(fake.users, 'findById').mockResolvedValue({ ...fake.user, active: false });
    await expect(fake.read(request(`__Host-cauce_session=${token()}`))).rejects.toThrow('access_denied');
  });
  it('accepts the verified credential for a successful same-second login', async () => {
    const fake = await fixture(10_000_250);
    const app = Fastify();
    app.post('/login', (req, reply) => fake.provider.login(req, reply));
    try {
      const response = await app.inject({ method: 'POST', url: '/login', payload: { email: fake.user.email, password: 'fixture-password' } });
      expect(response.statusCode).toBe(200);
      const cookie = String(response.headers['set-cookie']).split(';')[0];
      expect((await fake.provider.authenticateHttp(request(cookie))).operator_profile?.id).toBe(`console:${userId}`);
      expect(await fake.read(request(cookie))).toMatchObject({ userId });
    } finally { await app.close(); }
  });
});
