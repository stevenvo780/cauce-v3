import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { AuthError, type AuthProvider, type Principal } from '../auth.js';
import { providerAuthActor, registerProviderAuthRoutes } from './provider-auth.routes.js';
import { ProviderAuthManager } from './provider-auth.sessions.js';
import { PasswordAuthProvider, signConsoleSession } from '../password-auth.js';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';

const input = { operation_id: '00000000-0000-4000-8000-000000000050', expected_operation_version: 2, request_id: 'auth-request-one',
  provider_id: 'codex', account_id: 'codex-main', harness_id: 'codex', host_id: 'kratos', runtime_user: 'dev', profile_id: 'codex-main' };
async function fixture(options: { authenticated?: boolean; reader?: boolean } = {}) {
  const app = Fastify();
  const who: Principal = { tenant_id: 'Steven', alias: 'kant', session_id: 'console:1', channel: 'console',
    roles: options.reader ? [] : ['operator'], permissions: options.reader ? ['read'] : ['control'],
    operator_profile: { id: 'console:human-1', display_name: 'Person' } };
  const authenticate = async () => { if (options.authenticated === false) throw new AuthError('SYNTHETIC_PRIVATE_AUTH_ERROR'); return who; };
  const auth: AuthProvider = { name: 'fixture', mode: 'test', authenticateHttp: authenticate, authenticateHello: authenticate };
  const manager = new ProviderAuthManager({ authorize: async () => undefined, reserve: async () => ({
    stopAdapter: async () => ({ stopped: true }), openLogin: async () => ({ method: 'device',
      subscribeOutput: () => () => undefined, start: async () => undefined, write: async () => undefined,
      resize: async () => undefined, close: async () => ({ stopped: true }) }),
    verify: async () => ({ identity_matches: false, functional_call_verified: false }), release: async () => undefined,
  }), audit: async () => undefined });
  registerProviderAuthRoutes(app, auth, manager);
  return { app, manager };
}
describe('provider authentication control routes', () => {
  it('keeps the company selected by a verified password cookie in sensitive authority', async () => {
    const now = Date.now(); const key = Buffer.alloc(32, 7);
    const user = { id: '11111111-2222-4333-8444-555555555555', email: 'operator@example.test', display_name: 'Operator',
      role: 'operator' as const, tenant_id: 'Home', alias: 'owner', active: true, password_hash: '$scrypt$synthetic', password_changed_at: 0 };
    const provider = new PasswordAuthProvider({ users: new MemoryConsoleUserStore([user]), signingKey: key, now: () => now });
    const base = { iss: 'cauce-v3-gateway' as const, aud: 'cauce-v3-console' as const, sub: user.id, sid: 'a'.repeat(32),
      csrf: 'b'.repeat(32), iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60 };
    const actors = [];
    for (const cmp of ['company-one', 'company-two']) {
      const token = signConsoleSession(key, { ...base, cmp });
      const request = { headers: { cookie: `${provider.cookieName}=${token}` }, url: '/v3/console/provider-auth/sessions' } as FastifyRequest;
      actors.push(await providerAuthActor(request, provider, true));
    }
    expect(actors[0]).toMatchObject({ subject: `console:${user.id}`, requestedCompany: 'company-one' });
    expect(actors[1]).toMatchObject({ subject: `console:${user.id}`, requestedCompany: 'company-two' });
    expect(actors[0]).not.toEqual(actors[1]);
  });
  it('returns only metadata with no-store and permits cancelling before any agent exists', async () => {
    const { app } = await fixture();
    try {
      const response = await app.inject({ method: 'POST', url: '/v3/console/provider-auth/sessions', payload: input });
      expect(response.statusCode).toBe(202);
      expect(response.headers['cache-control']).toBe('no-store');
      const result = response.json<{ session_id: string; status: string }>();
      expect(result.status).toBe('awaiting_login');
      const cancelled = await app.inject({ method: 'POST', url: `/v3/console/provider-auth/sessions/${result.session_id}/cancel`, payload: {} });
      expect(cancelled.json()).toMatchObject({ status: 'cancelled', cleanup_pending: false });
    } finally { await app.close(); }
  });
  it.each([{ authenticated: false, status: 401 }, { reader: true, status: 403 }])('rejects unauthorized control without reflecting private authentication details', async (options) => {
    const { app } = await fixture(options);
    try {
      const response = await app.inject({ method: 'POST', url: '/v3/console/provider-auth/sessions', payload: input });
      expect(response.statusCode).toBe(options.status);
      expect(response.body).not.toContain('SYNTHETIC_PRIVATE');
    } finally { await app.close(); }
  });
  it('rejects login commands and invalid session identifiers without leaking request contents', async () => {
    const { app } = await fixture();
    try {
      const response = await app.inject({ method: 'POST', url: '/v3/console/provider-auth/sessions', payload: { ...input, command: 'SYNTHETIC_PRIVATE_COMMAND' } });
      expect(response.statusCode).toBe(400); expect(response.body).not.toContain('SYNTHETIC_PRIVATE');
      expect((await app.inject({ method: 'GET', url: '/v3/console/provider-auth/sessions/not-a-uuid' })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
