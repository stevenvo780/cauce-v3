import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, lockCompanyAuthority, readCompanyOffice, registerCompany, updateCompany, withTransaction, writeCompanyOffice,
  type CompanyAuthoritySource, type DatabasePool, type RegisteredCompany } from '../src/index.js';
import { provisionTestLogin, startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { registerCompanyRegistrationRoute } from '../../../services/gateway/src/company-registration.js';
import { createConsoleSecurityHook } from '../../../services/gateway/src/console-security.js';
import { PasswordAuthProvider, registerPasswordAuth } from '../../../services/gateway/src/password-auth.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PostgresConsoleCompanyAuthority } from '../../../services/gateway/src/console-user-authority.js';
import { registerCompanyOfficeRoutes } from '../../../services/gateway/src/console/company-office.routes.js';
import { registerCompanyRoutes } from '../../../services/gateway/src/routes/console/companies.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let runtime: DatabasePool | undefined;
let first: RegisteredCompany;
let second: RegisteredCompany;
let hash: string;
let app: FastifyInstance | undefined;
const PASSWORD = 'Registration test password 2026';
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeAll(async () => { hash = await hashPassword(PASSWORD); });
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); admin = current.adminPool;
  runtime = createPool(await provisionTestLogin(admin, current.adminUrl, 'cauce_gateway', 'cauce_runtime'));
  pool = runtime;
  first = await registerCompany(pool, { email: 'first@example.test', name: 'First', passwordHash: hash,
    company: { slug: 'north', name: 'North' } });
  second = await registerCompany(pool, { email: 'second@example.test', name: 'Second', passwordHash: hash,
    company: { slug: 'south', name: 'South' } });
});
afterEach(async () => { await app?.close(); app = undefined; await runtime?.end(); runtime = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const source = (company: RegisteredCompany): CompanyAuthoritySource => client => lockCompanyAuthority(client,
  { tenant: company.hub.id, alias: 'owner', humanId: company.user.id });
const room = (company: RegisteredCompany, x = 1) => ({ tenant_id: company.hub.id, room_id: 'office', x, y: 2,
  width: 10, height: 8, parts: [{ id: 'desk', label: 'Desk', x: 0, y: 0, width: 2, height: 1 }] });
async function http(): Promise<FastifyInstance> {
  app = Fastify(); app.addHook('onRequest', createConsoleSecurityHook({ allowedOrigins: ['https://console.test'] }));
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 17),
    companyAuthority: new PostgresConsoleCompanyAuthority(pool) });
  registerPasswordAuth(app, provider); registerCompanyRegistrationRoute(app, pool);
  registerCompanyOfficeRoutes(app, provider, pool); registerCompanyRoutes(app, provider, pool);
  await app.ready(); return app;
}

describe('public registration with durable owner and isolated office', () => {
  it('registers from the runtime role atomically and resolves the human as a company owner', async () => {
    expect((await pool.query('SELECT current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ role: 'cauce_gateway', rolsuper: false }]);
    expect((await pool.query("SELECT pg_has_role(current_user,'cauce_runtime','MEMBER') AS runtime")).rows[0]).toEqual({ runtime: true });
    expect(await withTransaction(pool, source(first))).toMatchObject({ role: 'company_owner', actingCompany: 'north', humanId: first.user.id });
    expect((await pool.query('SELECT role,permissions FROM human_tenant_memberships WHERE human_id=$1', [first.user.id])).rows)
      .toEqual([{ role: 'operator', permissions: ['route','read','control','notify'] }]);
    await expect(pool.query("INSERT INTO companies(id,name) VALUES('forbidden','Forbidden')")).rejects.toMatchObject({ code: '42501' });
    expect(JSON.stringify(first)).not.toContain('$scrypt$');
  });

  it('rolls back a duplicate email and serializes concurrent company registrations without orphan hubs', async () => {
    await expect(registerCompany(pool, { email: 'first@example.test', name: 'Duplicate', passwordHash: hash,
      company: { slug: 'orphan', name: 'Orphan' } })).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT id FROM companies WHERE id='orphan'")).rows).toEqual([]);
    const attempts = await Promise.allSettled([1,2].map(index => registerCompany(pool,
      { email: `concurrent${String(index)}@example.test`, name: 'Concurrent', passwordHash: hash, company: { slug: 'race', name: 'Race' } })));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM tenants WHERE company_id='race'")).rows).toEqual([{ count: 1 }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM company_admins WHERE company_id='race'")).rows).toEqual([{ count: 1 }]);
  });

  it('persists homonymous rooms independently and rejects foreign rooms without changing the version', async () => {
    expect(await readCompanyOffice(pool, source(first))).toEqual({ company_id: 'north', version: 0, rooms: [] });
    const saved = await writeCompanyOffice(pool, source(first), { expected_version: 0, rooms: [room(first)] });
    expect(saved).toEqual({ company_id: 'north', version: 1, rooms: [room(first)] });
    expect(await readCompanyOffice(pool, source(first))).toEqual(saved);
    expect(await readCompanyOffice(pool, source(second))).toEqual({ company_id: 'south', version: 0, rooms: [] });
    await expect(writeCompanyOffice(pool, source(first), { expected_version: 1, rooms: [room(second)] })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await readCompanyOffice(pool, source(first))).toEqual(saved);
  });

  it('uses optimistic concurrency and removes purged rooms when the saved office is reread', async () => {
    await writeCompanyOffice(pool, source(first), { expected_version: 0, rooms: [room(first)] });
    const attempts = await Promise.allSettled([2,3].map(x => writeCompanyOffice(pool, source(first),
      { expected_version: 1, rooms: [room(first,x)] })));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await readCompanyOffice(pool, source(first))).version).toBe(2);
    await admin.query("UPDATE rooms SET enabled=false,retired_enabled=true,retired_at=now(),purged_at=now() WHERE tenant_id=$1 AND id='office'", [first.hub.id]);
    await expect(readCompanyOffice(pool, source(first))).rejects.toMatchObject({ code: 'forbidden' });
    await admin.query("INSERT INTO rooms(tenant_id,id) VALUES($1,'replacement')", [first.hub.id]);
    await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'replacement','owner','operator')", [first.hub.id]);
    expect((await readCompanyOffice(pool, source(first))).rooms).toEqual([]);
  });

  it('keeps the stored position of a room that is temporarily disabled when the plan is saved', async () => {
    await admin.query("INSERT INTO rooms(tenant_id,id) VALUES($1,'extra')", [first.hub.id]);
    await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'extra','owner','operator')", [first.hub.id]);
    const extra = { ...room(first, 500), room_id: 'extra' };
    await writeCompanyOffice(pool, source(first), { expected_version: 0, rooms: [room(first), extra] });
    await admin.query("UPDATE rooms SET enabled=false WHERE tenant_id=$1 AND id='extra'", [first.hub.id]);
    const saved = await writeCompanyOffice(pool, source(first), { expected_version: 1, rooms: [room(first, 7)] });
    expect(saved.rooms).toEqual([room(first, 7)]);
    await admin.query("UPDATE rooms SET enabled=true WHERE tenant_id=$1 AND id='extra'", [first.hub.id]);
    expect((await readCompanyOffice(pool, source(first))).rooms).toEqual(expect.arrayContaining([room(first, 7), extra]));
  });

  it('revokes durable authority and refuses an owner session after the company is retired', async () => {
    const updated = await withTransaction(pool, async client => updateCompany(client, await source(first)(client), 'north',
      { expected_version: 1, name: 'North edited' }));
    expect(updated).toMatchObject({ id: 'north', name: 'North edited', version: 2 });
    await expect(withTransaction(pool, async client => updateCompany(client, await source(first)(client), 'south',
      { expected_version: 1, name: 'Foreign' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(withTransaction(pool, async client => updateCompany(client, await source(first)(client), 'north',
      { expected_version: 1, name: 'Stale' }))).rejects.toMatchObject({ code: 'conflict' });
    await withTransaction(pool, async client => updateCompany(client, await source(first)(client), 'north', { expected_version: 2, state: 'retired' }));
    expect(await withTransaction(pool, source(first))).toMatchObject({ role: 'none' });
    await expect(writeCompanyOffice(pool, source(first), { expected_version: 0, rooms: [] })).rejects.toMatchObject({ code: 'forbidden' });
    await admin.query('DELETE FROM company_admins WHERE company_id=$1 AND human_id=$2', ['south', second.user.id])
      .then(() => { throw new Error('last owner removed'); }, (error: unknown) => { expect(error).toMatchObject({ code: '23514' }); });
  });

  it('registers through HTTP, logs in using the existing password flow, then saves and reloads the office', async () => {
    const gateway = await http();
    const input = { email: 'new@example.test', name: 'New user', password: PASSWORD, company: { slug: 'newco', name: 'NewCo' } };
    const registered = await gateway.inject({ method: 'POST', url: '/v3/auth/register', headers: { origin: 'https://console.test' }, payload: input });
    expect(registered.statusCode).toBe(201); expect(registered.headers['set-cookie']).toBeUndefined();
    const created = registered.json<RegisteredCompany>(); expect(created.company.id).toBe('newco');
    expect(registered.body).not.toContain(PASSWORD); expect(registered.body).not.toContain('$scrypt$');
    const logged = await gateway.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: 'https://console.test' },
      payload: { email: input.email, password: PASSWORD } });
    expect(logged.statusCode).toBe(200); const state = logged.json<{ csrf_token: string }>();
    const cookie = String(logged.headers['set-cookie']).split(';')[0] ?? '';
    const saved = await gateway.inject({ method: 'PUT', url: '/v3/console/office/layout',
      headers: { origin: 'https://console.test', cookie, 'x-csrf-token': state.csrf_token },
      payload: { expected_version: 0, rooms: [room(created)] } });
    expect(saved.statusCode).toBe(200);
    const reloaded = await gateway.inject({ method: 'GET', url: '/v3/console/office/layout', headers: { cookie } });
    expect(reloaded.statusCode).toBe(200); expect(reloaded.json()).toMatchObject(saved.json());
    const companies = await gateway.inject({ method: 'GET', url: '/v3/console/companies', headers: { cookie } });
    expect(companies.statusCode).toBe(200); expect(companies.json<{ companies: unknown[] }>().companies).toHaveLength(1);
  });

  it('requires origin, rejects role escalation and limits registration attempts before database writes', async () => {
    const gateway = await http();
    const input = { email: 'denied@example.test', name: 'Denied', password: PASSWORD, company: { slug: 'denied', name: 'Denied' } };
    expect((await gateway.inject({ method: 'POST', url: '/v3/auth/register', payload: input })).statusCode).toBe(403);
    expect((await gateway.inject({ method: 'POST', url: '/v3/auth/register', headers: { origin: 'https://evil.test' }, payload: input })).statusCode).toBe(403);
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await gateway.inject({ method: 'POST', url: '/v3/auth/register',
      headers: { origin: 'https://console.test' }, payload: { ...input, role: 'platform_admin' } })).statusCode).toBe(400);
    expect((await gateway.inject({ method: 'POST', url: '/v3/auth/register', headers: { origin: 'https://console.test' }, payload: input })).statusCode).toBe(429);
    expect((await pool.query("SELECT id FROM companies WHERE id='denied'")).rows).toEqual([]);
  });

  it('does not grant administrative authority to a reader or to an unverified owner alias', async () => {
    const id = randomUUID();
    await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,$2,$2,$3,'Reader','reader',$4,'owner')`, [id, `${id}@example.test`, hash, first.hub.id]);
    await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,$2,'owner','reader',ARRAY['read'])`, [id, first.hub.id]);
    const reader: CompanyAuthoritySource = client => lockCompanyAuthority(client, { tenant: first.hub.id, alias: 'owner', humanId: id });
    expect(await withTransaction(pool, reader)).toMatchObject({ role: 'reader' });
    await expect(writeCompanyOffice(pool, reader, { expected_version: 0, rooms: [] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(writeCompanyOffice(pool, client => lockCompanyAuthority(client, { tenant: first.hub.id, alias: 'owner' }),
      { expected_version: 0, rooms: [] })).rejects.toMatchObject({ code: 'forbidden' });
    await admin.query(`UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1`, [second.user.id]);
    expect(await withTransaction(pool, source(second))).toMatchObject({ role: 'none' });
  });
});
