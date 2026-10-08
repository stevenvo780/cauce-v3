import Fastify from 'fastify';
import { FleetOperationError } from '@cauce/store';
import { expect, it, vi } from 'vitest';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';
import { PasswordAuthProvider, signConsoleSession } from '../password-auth.js';
import { createConsoleCredentialStamp } from '../console-credential-stamp.js';
import { registerLegacyFleetAdoptionRoutes } from './adoption-routes.js';
import { runLegacyAdoptionInstaller } from './adoption-installer.js';
import { LegacyAdoptionError, type LegacyAdoptionActor } from '../../../../packages/store/src/fleet-adoption-contracts.js';
import type { LegacyFleetAdoptionService } from './adoption.js';

const path = '/v3/console/fleet/legacy-adoption';
const id = '00000000-0000-4000-8000-000000000061';
const target = { tenant_id: 'Steven', alias: 'legacy-proof' }; const targets = [target];
const plan = { revision: 0, targets, rows: [], blockers: [{ target, code: 'facts_unavailable' as const }], can_apply: false, plan_sha256: 'a'.repeat(64) };
function service() {
  return { preview: vi.fn<LegacyFleetAdoptionService['preview']>(async () => plan),
    apply: vi.fn<LegacyFleetAdoptionService['apply']>(async () => { throw new LegacyAdoptionError('conflict'); }) };
}
async function fixture() {
  const users = new MemoryConsoleUserStore(); const key = Buffer.alloc(32, 2); const now = Math.floor(Date.now() / 1000);
  const user = { id, email: 'adoption@example.test', display_name: 'Adoption', role: 'operator' as const,
    tenant_id: 'Steven', alias: 'legacy-operator', active: true, password_hash: '$scrypt$' + 'x'.repeat(48), password_changed_at: 0, password_changed_at_us: '0' };
  users.put(user); const provider = new PasswordAuthProvider({ users, signingKey: key }); const csrf = Buffer.alloc(32, 1).toString('base64url');
  const cookie = signConsoleSession(key, { iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: id, sid: 'adoption-fixture-session',
    iat: now, exp: now + 60, csrf, credential_stamp: createConsoleCredentialStamp(key, { userId: id, passwordHash: user.password_hash, passwordChangedAtUs: '0' }) });
  const api = service(); const app = Fastify(); registerLegacyFleetAdoptionRoutes(app, provider, api);
  return { app, users, user, api, headers: { cookie: `__Host-cauce_session=${cookie}`, 'x-csrf-token': csrf } };
}
it('requires fresh human cookie control and CSRF for both preview and apply', async () => {
  const f = await fixture(); try {
    for (const headers of [{}, { cookie: f.headers.cookie }, { ...f.headers, authorization: 'Bearer synthetic' }]) {
      expect((await f.app.inject({ method: 'POST', url: path + '/preview', headers, payload: { targets } })).statusCode).toBe(403);
      expect((await f.app.inject({ method: 'POST', url: path + '/apply', headers, payload: { preview: plan } })).statusCode).toBe(403);
    }
    expect(f.api.preview).not.toHaveBeenCalled(); expect(f.api.apply).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});
it('derives human origin on the server and preserves detailed blockers without serving physical facts', async () => {
  const f = await fixture(); try {
    const response = await f.app.inject({ method: 'POST', url: path + '/preview', headers: f.headers, payload: { targets } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(plan);
    const actor = f.api.preview.mock.calls[0]?.[0]; expect(actor).toMatchObject({ tenant_id: 'Steven', alias: 'legacy-operator', subject: `console:${id}` });
    expect(typeof actor?.authorize).toBe('function'); expect(response.headers['cache-control']).toBe('no-store');
    for (const extra of [{ actor: { subject: 'system:legacy-fleet-installer' } }, { facts: { auth: 'PRIVATE' } }])
      expect((await f.app.inject({ method: 'POST', url: path + '/preview', headers: f.headers, payload: { targets, ...extra } })).statusCode).toBe(400);
    expect(f.api.preview).toHaveBeenCalledOnce();
  } finally { await f.app.close(); }
});
it('rejects current reader and revoked human accounts even with an earlier operator cookie', async () => {
  const f = await fixture(); try {
    f.users.put({ ...f.user, role: 'reader' });
    expect((await f.app.inject({ method: 'POST', url: path + '/preview', headers: f.headers, payload: { targets } })).statusCode).toBe(403);
    f.users.put({ ...f.user, active: false });
    expect((await f.app.inject({ method: 'POST', url: path + '/apply', headers: f.headers, payload: { preview: plan } })).statusCode).toBe(401);
    expect(f.api.preview).not.toHaveBeenCalled(); expect(f.api.apply).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});
it('returns only public failure codes and blockers from a failed application', async () => {
  const f = await fixture(); f.api.apply.mockRejectedValueOnce(new LegacyAdoptionError('conflict', [{ target, code: 'active_delivery' }]));
  try {
    const response = await f.app.inject({ method: 'POST', url: path + '/apply', headers: f.headers, payload: { preview: plan } });
    expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ error: 'conflict', blockers: [{ target: targets[0], code: 'active_delivery' }] });
  } finally { await f.app.close(); }
});
it('returns forbidden when durable fleet control is revoked after cookie authentication', async () => {
  const f = await fixture();
  f.api.preview.mockRejectedValueOnce(new FleetOperationError('forbidden', 'PRIVATE_FLEET_AUTHORITY'));
  f.api.apply.mockRejectedValueOnce(new FleetOperationError('forbidden', 'PRIVATE_FLEET_AUTHORITY'));
  try {
    for (const [action, payload] of [['preview', { targets }], ['apply', { preview: plan }]] as const) {
      const response = await f.app.inject({ method: 'POST', url: path + '/' + action, headers: f.headers, payload });
      expect(response.statusCode).toBe(403); expect(response.json()).toEqual({ error: 'forbidden', blockers: [] });
      expect(response.body).not.toContain('PRIVATE');
    }
  } finally { await f.app.close(); }
});
it('exposes a separate installer command that accepts no caller facts or human origin', async () => {
  const api = service(); const actor: LegacyAdoptionActor = { tenant_id: 'Steven', alias: 'legacy-operator', subject: 'system:legacy-fleet-installer', authorize: async () => undefined };
  expect(await runLegacyAdoptionInstaller(api, actor, { mode: 'preview', targets })).toEqual(plan);
  await expect(runLegacyAdoptionInstaller(api, { ...actor, subject: `console:${id}` }, { mode: 'preview', targets })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(runLegacyAdoptionInstaller(api, actor, { mode: 'preview', targets, facts: {} })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(runLegacyAdoptionInstaller(api, actor, { mode: 'apply', preview: plan })).rejects.toMatchObject({ code: 'conflict' });
  expect(api.preview).toHaveBeenCalledOnce(); expect(api.apply).toHaveBeenCalledOnce();
});
