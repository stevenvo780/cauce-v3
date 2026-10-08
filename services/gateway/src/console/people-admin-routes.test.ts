import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerPeopleAdminRoutes, type PeopleAdminRepositoryBinding } from './people-admin-routes.js';
import { PasswordAuthProvider, signConsoleSession } from '../password-auth.js';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';
import { createConsoleCredentialStamp } from '../console-credential-stamp.js';
import { PeopleAdminError } from './people-admin-schema.js';

const id = '00000000-0000-4000-8000-000000000061';
const row = { id, email: 'fixture@example.test', display_name: 'Fixture', role: 'reader', tenant_id: 'Steven', alias: 'fixture-user', active: true, revision: '1791432000000000' };
async function fixture(options: { reader?: boolean; error?: Error; privateReceipt?: boolean; wrongId?: boolean; stale?: boolean; ignoredPatch?: boolean; duplicates?: boolean } = {}) {
  const users = new MemoryConsoleUserStore(); const key = Buffer.alloc(32, 2); const now = Date.now();
  const user = { id, email: row.email, display_name: 'Person', role: options.reader ? 'reader' as const : 'operator' as const,
    tenant_id: 'Steven', alias: 'fixture-user', active: true, password_hash: '$scrypt$' + 'x'.repeat(48), password_changed_at: 0, password_changed_at_us: '0' };
  users.put(user); const auth = new PasswordAuthProvider({ users, signingKey: key });
  const stamp = createConsoleCredentialStamp(key, { userId: id, passwordHash: user.password_hash, passwordChangedAtUs: '0' });
  const token = signConsoleSession(key, { iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: id, sid: 'fixture-login-session',
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60, csrf: Buffer.alloc(32, 1).toString('base64url'), credential_stamp: stamp });
  let writes = 0;
  const receipt = async (patch: object = {}) => { writes += 1; if (options.error) throw options.error;
    return { ...row, revision: options.stale ? row.revision : (BigInt(row.revision) + 1n).toString(),
      ...(options.ignoredPatch ? {} : patch), ...(options.wrongId ? { id: '00000000-0000-4000-8000-000000000062' } : {}),
      ...(options.privateReceipt ? { password: 'PRIVATE_TOKEN' } : {}) }; };
  const repository: PeopleAdminRepositoryBinding = { list: async () => ({ items: options.duplicates ? [row, row] : [row], capabilities: { create: true, update: true, retire: true, restore: true, purge: true } }),
    create: (_actor, input) => { const { password: _password, ...fields } = input; return receipt(fields); },
    update: (_actor, _id, input) => { const { expected_revision: _revision, password: _password, ...fields } = input; return receipt(fields); },
    retire: () => receipt({ active: false }), restore: () => receipt({ active: true }),
    purge: async () => ({ id: options.wrongId ? '00000000-0000-4000-8000-000000000062' : id, revision: row.revision, purged: true }) };
  const app = Fastify(); registerPeopleAdminRoutes(app, auth, repository);
  return { app, headers: { cookie: `__Host-cauce_session=${token}`, 'x-csrf-token': Buffer.alloc(32, 1).toString('base64url') }, writes: () => writes };
}
describe('human administration routes', () => {
  it('normalizes mixed-case create and update emails before writing and validating receipts', async () => {
    const f = await fixture(); try {
      const created = await f.app.inject({ method: 'POST', url: '/v3/console/people', headers: f.headers,
        payload: { email: '  NEW@Example.TEST ', display_name: 'New', role: 'reader', tenant_id: 'Steven', alias: 'new-user', active: true, password: 'fixture-password' } });
      expect(created.statusCode).toBe(201); expect(created.json<{ email: string }>().email).toBe('new@example.test');
      const updated = await f.app.inject({ method: 'PATCH', url: `/v3/console/people/${id}`, headers: f.headers,
        payload: { expected_revision: row.revision, email: ' CHANGED@Example.TEST ' } });
      expect(updated.statusCode).toBe(200); expect(updated.json<{ email: string }>().email).toBe('changed@example.test');
    } finally { await f.app.close(); }
  });
  it('requires a signed human cookie and control permission before exposing any people metadata', async () => {
    const f = await fixture(); try {
      expect((await f.app.inject('/v3/console/people')).statusCode).toBe(401);
      const list = await f.app.inject({ url: '/v3/console/people', headers: f.headers }); expect(list.statusCode).toBe(200);
      expect(list.headers['cache-control']).toBe('no-store'); expect(list.json<{ items: unknown[] }>().items).toEqual([row]);
    } finally { await f.app.close(); }
    const reader = await fixture({ reader: true }); try {
      expect((await reader.app.inject({ url: '/v3/console/people', headers: reader.headers })).statusCode).toBe(403);
    } finally { await reader.app.close(); }
  });
  it('rejects raw passwords in receipts and sensitive arbitrary fields before a write', async () => {
    const f = await fixture({ privateReceipt: true }); try {
      const invalid = await f.app.inject({ method: 'PATCH', url: `/v3/console/people/${id}`, headers: f.headers,
        payload: { expected_revision: row.revision, password_hash: 'PRIVATE_RAW_HASH' } });
      expect(invalid.statusCode).toBe(400); expect(f.writes()).toBe(0); expect(invalid.body).not.toContain('PRIVATE');
      const result = await f.app.inject({ method: 'PATCH', url: `/v3/console/people/${id}`, headers: f.headers,
        payload: { expected_revision: row.revision, display_name: 'New' } });
      expect(result.statusCode).toBe(503); expect(result.body).not.toContain('PRIVATE');
    } finally { await f.app.close(); }
  });
  it('returns a safe conflict for last-admin refusal without reflecting internal errors', async () => {
    const f = await fixture({ error: new PeopleAdminError('conflict') }); try {
      const result = await f.app.inject({ method: 'DELETE', url: `/v3/console/people/${id}`, headers: f.headers, payload: { expected_revision: row.revision } });
      expect(result.statusCode).toBe(409); expect(result.json<{ error: string }>().error).toBe('conflict');
    } finally { await f.app.close(); }
    const broken = await fixture({ error: new Error('PRIVATE_DATABASE_FAILURE') }); try {
      const result = await broken.app.inject({ method: 'DELETE', url: `/v3/console/people/${id}`, headers: broken.headers, payload: { expected_revision: row.revision } });
      expect(result.statusCode).toBe(503); expect(result.body).not.toContain('PRIVATE');
    } finally { await broken.app.close(); }
  });
  it('rejects a missing or mismatched CSRF token before a mutation', async () => {
    const f = await fixture(); try {
      for (const headers of [{ cookie: f.headers.cookie }, { ...f.headers, 'x-csrf-token': 'invalid' }]) {
        const response = await f.app.inject({ method: 'DELETE', url: `/v3/console/people/${id}`, headers, payload: { expected_revision: row.revision } });
        expect(response.statusCode).toBe(403); expect(f.writes()).toBe(0);
      }
    } finally { await f.app.close(); }
  });
  it('checks the receipt identity, advancing revision and exact requested fields', async () => {
    for (const options of [{ wrongId: true }, { stale: true }, { ignoredPatch: true }]) {
      const f = await fixture(options); try {
        const response = await f.app.inject({ method: 'PATCH', url: `/v3/console/people/${id}`, headers: f.headers,
          payload: { expected_revision: row.revision, display_name: 'Changed' } });
        expect(response.statusCode).toBe(503);
      } finally { await f.app.close(); }
    }
    const duplicate = await fixture({ duplicates: true }); try {
      expect((await duplicate.app.inject({ url: '/v3/console/people', headers: duplicate.headers })).statusCode).toBe(503);
    } finally { await duplicate.app.close(); }
  });
  it('checks every create, retirement, restoration and purge receipt', async () => {
    const good = await fixture(); try {
      const create = { email: 'new@example.test', display_name: 'New', role: 'operator', tenant_id: 'Steven', alias: 'new-user', active: false, password: 'fixture-password' };
      expect((await good.app.inject({ method: 'POST', url: '/v3/console/people', headers: good.headers, payload: create })).statusCode).toBe(201);
      for (const [method, suffix] of [['DELETE', ''], ['POST', '/restore'], ['DELETE', '/purge']] as const) {
        expect((await good.app.inject({ method, url: `/v3/console/people/${id}${suffix}`, headers: good.headers, payload: { expected_revision: row.revision } })).statusCode).toBe(200);
      }
    } finally { await good.app.close(); }
    const wrong = await fixture({ wrongId: true }); try {
      expect((await wrong.app.inject({ method: 'DELETE', url: `/v3/console/people/${id}/purge`, headers: wrong.headers, payload: { expected_revision: row.revision } })).statusCode).toBe(503);
    } finally { await wrong.app.close(); }
    const ignored = await fixture({ ignoredPatch: true }); try {
      expect((await ignored.app.inject({ method: 'DELETE', url: `/v3/console/people/${id}`, headers: ignored.headers, payload: { expected_revision: row.revision } })).statusCode).toBe(503);
      expect((await ignored.app.inject({ method: 'POST', url: '/v3/console/people', headers: ignored.headers,
        payload: { ...row, id: undefined, revision: undefined, display_name: 'Changed', password: 'fixture-password' } })).statusCode).toBe(503);
    } finally { await ignored.app.close(); }
  });
});
