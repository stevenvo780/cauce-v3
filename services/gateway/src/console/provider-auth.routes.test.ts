import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AuthError, type AuthProvider, type Principal } from '../auth.js';
import { registerProviderAuthRoutes } from './provider-auth.routes.js';
import { ProviderAuthManager } from './provider-auth.sessions.js';

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
