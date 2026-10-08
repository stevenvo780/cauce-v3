import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createAgentProfileDraftBinding } from './agent-profile-draft.js';
import { registerAgentProfileRoutes } from './agent-profile.routes.js';
import { profileWriteFixtureDeps, contexto, PERFIL_BODY } from './agent-profile.fixtures.js';
import { PasswordAuthProvider, signConsoleSession } from '../password-auth.js';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';
import { createConsoleCredentialStamp } from '../console-credential-stamp.js';
import { StoreError, type AgentProfileRepository } from '@cauce/store';

const path = '/v3/console/tenants/Steven/agents/zeus/perfil'; const id = '00000000-0000-4000-8000-000000000061';
async function fixture(options: { wrongReceipt?: boolean; error?: Error; enabled?: boolean } = {}) {
  const users = new MemoryConsoleUserStore(); const key = Buffer.alloc(32, 2); const now = Math.floor(Date.now() / 1000);
  const user = { id, email: 'draft@example.test', display_name: 'Draft', role: 'operator' as const, tenant_id: 'Steven', alias: 'kant', active: true,
    password_hash: '$scrypt$' + 'x'.repeat(48), password_changed_at: 0, password_changed_at_us: '0' };
  users.put(user); const provider = new PasswordAuthProvider({ users, signingKey: key });
  const csrf = Buffer.alloc(32, 1).toString('base64url');
  const cookie = signConsoleSession(key, { iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: id, sid: 'fixture-login-session', iat: now, exp: now + 60,
    csrf, credential_stamp: createConsoleCredentialStamp(key, { userId: id, passwordHash: user.password_hash, passwordChangedAtUs: '0' }) });
  const saved = { perfil: contexto(PERFIL_BODY, 'codex').perfil, exists: true as const, revision: 2, applied_revision: 1 };
  const prepare = vi.fn<AgentProfileRepository['prepareDraft']>(async () => { if (options.error) throw options.error; return options.wrongReceipt ? { ...saved, applied_revision: 2 } : saved; });
  const configure = vi.fn(async () => ({ tenant_id: 'Steven', alias: 'zeus', harness_id: 'codex', home_directory: '/home/dev', enabled: options.enabled === true }));
  const binding = createAgentProfileDraftBinding(provider, { prepareDraft: prepare, canPrepareDraft: async () => true }, { authorizeAgentTarget: configure });
  const runtime = vi.fn(async () => { throw new Error('must not touch runtime'); });
  const deps = profileWriteFixtureDeps({ ...binding, prepareRuntime: runtime,
    authorizeTarget: async (_actor, tenant, alias, permission) => permission === 'control' ? undefined : ({ tenant_id: tenant, alias, enabled: options.enabled === true }),
    readContext: async () => ({ contexto: contexto({ ...PERFIL_BODY, purpose: 'Prior' }, 'codex'), exists: true, revision: 1, applied_revision: 1 }),
  }, { operator_id: user.email, attributed: true });
  const app = Fastify(); registerAgentProfileRoutes(app, deps);
  return { app, prepare, runtime, users, user, headers: { cookie: `__Host-cauce_session=${cookie}`, 'x-csrf-token': csrf } };
}
describe('preparing disabled profile from a human console', () => {
  it('returns an exact desired receipt without runtime, expectation or ACK', async () => {
    const f = await fixture(); try {
      const response = await f.app.inject({ method: 'PUT', url: path, headers: f.headers,
        payload: { profile: PERFIL_BODY, expected_revision: 1, reason: 'Preparar el contexto antes de iniciar' } });
      expect(response.statusCode).toBe(202); expect(response.json()).toMatchObject({ ok: true, state: 'prepared_disabled', agent_enabled: false, revision: 2, desired_revision: 2, applied_revision: 1 });
      expect(f.prepare).toHaveBeenCalledOnce(); expect(f.runtime).not.toHaveBeenCalled();
      expect(f.prepare.mock.calls[0]?.[2]).toMatchObject({ subject: `console:${id}`, tenant_id: 'Steven', alias: 'kant' });
    } finally { await f.app.close(); }
  });
  it('shows draft capability only for a fresh signed human cookie and disabled configure target', async () => {
    const f = await fixture(); try {
      const read = async (headers: typeof f.headers | undefined) => f.app.inject({ url: path, ...(headers === undefined ? {} : { headers }) });
      expect((await read(f.headers)).json()).toMatchObject({ can_prepare_draft: true, agent_enabled: false });
      expect((await read(undefined)).json()).toMatchObject({ can_prepare_draft: false });
      f.users.put({ ...f.user, role: 'reader' });
      expect((await read(f.headers)).json()).toMatchObject({ can_prepare_draft: false });
    } finally { await f.app.close(); }
  });
  it('refuses machine/no-cookie, stale human and CSRF-less writes before saving', async () => {
    const f = await fixture(); try {
      const payload = { profile: PERFIL_BODY, expected_revision: 1, reason: 'Preparar el contexto antes de iniciar' };
      for (const headers of [{}, { cookie: f.headers.cookie }, { ...f.headers, authorization: 'Bearer synthetic' }]) {
        expect((await f.app.inject({ method: 'PUT', url: path, headers, payload })).statusCode).toBe(403);
      }
      f.users.put({ ...f.user, active: false });
      expect((await f.app.inject({ method: 'PUT', url: path, headers: f.headers, payload })).statusCode).toBe(403);
      expect(f.prepare).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('fails safely on wrong applied receipts, unavailable authority and enabled targets', async () => {
    for (const options of [{ wrongReceipt: true }, { error: new Error('PRIVATE_DATABASE') }, { error: new StoreError('forbidden', 'PRIVATE_MEMBERSHIP') }, { enabled: true }]) {
      const f = await fixture(options); try {
        const response = await f.app.inject({ method: 'PUT', url: path, headers: f.headers,
          payload: { profile: PERFIL_BODY, expected_revision: 1, reason: 'Preparar el contexto antes de iniciar' } });
        expect(response.statusCode).toBe(options.error instanceof StoreError || options.enabled ? 403 : 503);
        expect(response.body).not.toContain('PRIVATE'); expect(f.runtime).not.toHaveBeenCalled();
      } finally { await f.app.close(); }
    }
  });
});
