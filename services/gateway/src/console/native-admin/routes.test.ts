import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { PasswordAuthProvider, signConsoleSession } from '../../password-auth.js';
import { MemoryConsoleUserStore } from '../../test-support/console-users.js';
import { createConsoleCredentialStamp } from '../../console-credential-stamp.js';
import { registerNativeAdminRoutes } from './routes.js';
import { NativeAdminError, type NativeAdminService } from './service.js';

const path = '/v3/console/tenants/Steven/agents/zeus/native/skill/native-proof';
const id = '00000000-0000-4000-8000-000000000061';
const identity = { generation: 'fixture-generation', container_id: 'fixture-container', writer_instance_id: id };
async function fixture() {
  const users = new MemoryConsoleUserStore(); const key = Buffer.alloc(32, 2); const now = Math.floor(Date.now() / 1000);
  const user = { id, email: 'native@example.test', display_name: 'Native', role: 'operator' as const, tenant_id: 'Steven', alias: 'kant', active: true,
    password_hash: '$scrypt$' + 'x'.repeat(48), password_changed_at: 0, password_changed_at_us: '0' };
  users.put(user); const provider = new PasswordAuthProvider({ users, signingKey: key }); const csrf = Buffer.alloc(32, 1).toString('base64url');
  const cookie = signConsoleSession(key, { iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: id, sid: 'native-fixture-session', iat: now, exp: now + 60,
    csrf, credential_stamp: createConsoleCredentialStamp(key, { userId: id, passwordHash: user.password_hash, passwordChangedAtUs: '0' }) });
  const write = vi.fn<NativeAdminService['write']>(async () => { throw new NativeAdminError('conflict'); });
  const read = vi.fn<NativeAdminService['read']>(); const recognize = vi.fn<NativeAdminService['recognize']>();
  const discover = vi.fn<NativeAdminService['discover']>();
  const app = Fastify(); registerNativeAdminRoutes(app, provider, { write, read, recognize, recover: vi.fn(), discover });
  return { app, users, user, write, discover, headers: { cookie: `__Host-cauce_session=${cookie}`, 'x-csrf-token': csrf } };
}
const payload = { mutation: { kind: 'skill', id: 'native-proof', action: 'put', expected_sha: null,
  value: { content: '---\nname: native-proof\ndescription: Valid native piece\n---\nRead.\n' } }, reason: 'Crear la pieza nativa de prueba', identity };
describe('native administration human boundary', () => {
  it('refuses no-cookie, bearer and CSRF-less mutations before dispatch', async () => {
    const f = await fixture(); try {
      for (const headers of [{}, { cookie: f.headers.cookie }, { ...f.headers, authorization: 'Bearer synthetic' }]) {
        expect((await f.app.inject({ method: 'PUT', url: path, payload, headers })).statusCode).toBe(403);
      }
      expect(f.write).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('revalidates current human role and active state instead of trusting the cookie', async () => {
    const f = await fixture(); try {
      f.users.put({ ...f.user, role: 'reader' });
      expect((await f.app.inject({ method: 'PUT', url: path, payload, headers: f.headers })).statusCode).toBe(403);
      f.users.put({ ...f.user, active: false });
      expect((await f.app.inject({ method: 'PUT', url: path, payload, headers: f.headers })).statusCode).toBe(401);
      expect(f.write).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('passes fresh human authority and both target coordinates; rejects arbitrary paths', async () => {
    const f = await fixture(); try {
      expect((await f.app.inject({ method: 'PUT', url: path, payload, headers: f.headers })).statusCode).toBe(409);
      expect(f.write.mock.calls[0]?.slice(1, 3)).toEqual(['Steven', 'zeus']);
      expect(f.write.mock.calls[0]?.[0].subject).toBe(`console:${id}`);
      expect(typeof f.write.mock.calls[0]?.[0].humanAuthority).toBe('function');
      for (const mutation of [{ ...payload.mutation, path: '/tmp/auth.json' }, { ...payload.mutation, id: 'other' }, { ...payload.mutation, action: 'delete' }]) {
        expect((await f.app.inject({ method: 'PUT', url: path, payload: { ...payload, mutation }, headers: f.headers })).statusCode).toBe(400);
      }
      expect(f.write).toHaveBeenCalledOnce();
    } finally { await f.app.close(); }
  });
  it('reports uncertain effect with operation identity and no private error details', async () => {
    const f = await fixture(); try {
      f.write.mockRejectedValueOnce(new NativeAdminError('unavailable', id));
      const response = await f.app.inject({ method: 'PUT', url: path, payload, headers: f.headers });
      expect(response.statusCode).toBe(503); expect(response.json()).toMatchObject({ state: 'effect_unknown', operation_id: id });
      expect(response.body).not.toContain('PRIVATE');
    } finally { await f.app.close(); }
  });
  it('discovers through fresh scoped human control and CSRF without accepting a browser token or path', async () => {
    const f = await fixture(); const identity = { generation: 'fixture-generation', container_id: 'fixture-container', writer_instance_id: id };
    const body = { mutation: payload.mutation, identity, operation_id: id };
    f.discover.mockResolvedValueOnce({ tenant_id: 'Steven', alias: 'zeus', identity, state: 'pending', operation_id: id });
    try {
      for (const headers of [{}, { cookie: f.headers.cookie }, { ...f.headers, authorization: 'Bearer synthetic' }])
        expect((await f.app.inject({ method: 'POST', url: path + '/discover', payload: body, headers })).statusCode).toBe(403);
      expect(f.discover).not.toHaveBeenCalled();
      const response = await f.app.inject({ method: 'POST', url: path + '/discover', payload: body, headers: f.headers });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ tenant_id: 'Steven', alias: 'zeus', identity, state: 'pending', operation_id: id });
      expect(f.discover.mock.calls[0]?.slice(1, 3)).toEqual(['Steven', 'zeus']);
      for (const extra of [{ operation_token: id }, { path: '/tmp/auth.json' }])
        expect((await f.app.inject({ method: 'POST', url: path + '/discover', payload: { ...body, ...extra }, headers: f.headers })).statusCode).toBe(400);
      f.users.put({ ...f.user, role: 'reader' });
      expect((await f.app.inject({ method: 'POST', url: path + '/discover', payload: body, headers: f.headers })).statusCode).toBe(403);
      expect(f.discover).toHaveBeenCalledOnce();
    } finally { await f.app.close(); }
  });
  it('passes the public intended operation id to the writer without using it as the authorization token', async () => {
    const f = await fixture(); try {
      await f.app.inject({ method: 'PUT', url: path, payload: { ...payload, operation_id: id }, headers: f.headers });
      expect(f.write.mock.calls[0]?.[5]).toEqual(identity); expect(f.write.mock.calls[0]?.[6]).toBe(id);
    } finally { await f.app.close(); }
  });
  it('rejects noncanonical or non-v4 operation ids before write, discovery or recovery can reserve work', async () => {
    const f = await fixture(); try {
      for (const operation_id of ['00000000-0000-1000-8000-000000000061', 'AAAAAAAA-0000-4000-8000-000000000061']) {
        expect((await f.app.inject({ method: 'PUT', url: path, payload: { ...payload, operation_id }, headers: f.headers })).statusCode).toBe(400);
        expect((await f.app.inject({ method: 'POST', url: path + '/discover', payload: { mutation: payload.mutation, identity, operation_id }, headers: f.headers })).statusCode).toBe(400);
        expect((await f.app.inject({ method: 'POST', url: path + '/recover', payload: { mutation: payload.mutation, operation_id }, headers: f.headers })).statusCode).toBe(400);
      }
      expect(f.write).not.toHaveBeenCalled(); expect(f.discover).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
});
