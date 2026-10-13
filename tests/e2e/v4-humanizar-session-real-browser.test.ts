import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import {
  startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase,
} from '../helpers/postgres.js';

const PASSWORD = 'humanizar-session-fixture-password';
const STEVEN_EMAIL = 'steven-humanizar@example.test';
const MIGUEL_EMAIL = 'miguel-humanizar@example.test';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
let httpUrl = '';
let stevenId = '';
let miguelId = '';
let countsBefore: Record<string, number> = {};
let countsAfter: Record<string, number> = {};

async function coreCounts(): Promise<Record<string, number>> {
  if (!current) throw new Error('humanizar clone unavailable');
  const row = (await current.adminPool.query<Record<string, string>>(`SELECT
    (SELECT count(*)::text FROM tenants) AS tenants,
    (SELECT count(*)::text FROM rooms) AS rooms,
    (SELECT count(*)::text FROM agents) AS agents,
    (SELECT count(*)::text FROM memberships) AS memberships,
    (SELECT count(*)::text FROM console_users) AS console_users`)).rows[0] ?? {};
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Number(value)]));
}

async function seedMembership(admin: EmptyTestDatabase['adminPool'], human: string, tenant: string, alias: string): Promise<void> {
  const hasRole = (await admin.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='human_tenant_memberships' AND column_name='role'`,
  )).rowCount === 1;
  if (hasRole) {
    await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,$2,$3,'operator',ARRAY['read','control'])`, [human, tenant, alias]);
  } else {
    await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
      VALUES($1,$2,$3,ARRAY['read','control'])`, [human, tenant, alias]);
  }
}

async function seedHumanizarBaseline(): Promise<void> {
  if (!current) throw new Error('humanizar clone unavailable');
  const admin = current.adminPool;
  const hash = await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  stevenId = randomUUID();
  miguelId = randomUUID();
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Steven','operator','Steven','kant')`, [stevenId, STEVEN_EMAIL, hash]);
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Miguel','operator','Miguel','janus')`, [miguelId, MIGUEL_EMAIL, hash]);
  await admin.query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory)
    VALUES('Steven','kant',true,'codex','humanizar-session','dev','/home/dev','/home/dev/.cauce'),
          ('Miguel','janus',true,'codex','humanizar-session','dev','/home/dev','/home/dev/.cauce')
    ON CONFLICT (tenant_id,alias) DO NOTHING`);
  await seedMembership(admin, stevenId, 'Steven', 'kant');
  await seedMembership(admin, miguelId, 'Miguel', 'janus');
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven','kant','operator')
    ON CONFLICT (tenant_id,room_id,alias) DO UPDATE SET role='operator'`);
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Miguel','grp.miguel','janus','operator')
    ON CONFLICT (tenant_id,room_id,alias) DO UPDATE SET role='operator'`);
}

async function seedAuthority(): Promise<void> {
  if (!current) throw new Error('humanizar clone unavailable');
  await withTransaction(current.adminPool, async (client) => {
    await client.query('INSERT INTO platform_admins(human_id) VALUES($1)', [stevenId]);
    await client.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
      VALUES('humanizar',$1,'owner','import',$1),('humanizar',$2,'owner','import',$1)`, [stevenId, miguelId]);
  });
}

async function login(email: string): Promise<{ cookie: string }> {
  const response = await fetch(`${httpUrl}/v3/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: httpUrl },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  const [rawCookie] = response.headers.getSetCookie();
  if (!rawCookie) throw new Error('login returned no session cookie');
  return { cookie: rawCookie.split(';', 1)[0] ?? '' };
}

async function sessionAuthority(email: string): Promise<unknown> {
  const { cookie } = await login(email);
  const response = await fetch(`${httpUrl}/v3/auth/session`, { headers: { cookie } });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { authenticated?: unknown; authority?: unknown };
  expect(body.authenticated).toBe(true);
  return body.authority;
}

beforeAll(async () => {
  database = await startTestDatabase();
  current = await startTestCaseDatabase(database);
  await seedHumanizarBaseline();
  countsBefore = await coreCounts();
  await seedAuthority();
  countsAfter = await coreCounts();
  const provider = new PasswordAuthProvider({
    users: new PostgresConsoleUserStore(current.pool), signingKey: randomBytes(32),
  });
  await provider.ready();
  app = await buildGateway({ pool: current.pool, authProvider: provider });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${String(address.port)}`;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await current?.close();
  if (database) { await database.pool.end(); await database.container.stop(); }
}, 120_000);

describe('Humanizar en clon: sesión tras sembrar administradores', () => {
  it('la siembra deja un platform_admin y dos owners sin tocar los conteos base', async () => {
    if (!current) throw new Error('humanizar clone unavailable');
    expect(countsAfter).toEqual(countsBefore);
    const platform = (await current.adminPool.query<{ human_id: string }>(
      'SELECT human_id::text FROM platform_admins')).rows.map((row) => row.human_id);
    expect(platform).toEqual([stevenId]);
    const owners = (await current.adminPool.query<{ human_id: string }>(
      `SELECT human_id::text FROM company_admins WHERE company_id='humanizar' AND role='owner' ORDER BY human_id`))
      .rows.map((row) => row.human_id).sort();
    expect(owners).toEqual([stevenId, miguelId].sort());
  });

  it('GET /v3/auth/session devuelve platform_admin para Steven', async () => {
    expect(await sessionAuthority(STEVEN_EMAIL)).toEqual({
      role: 'platform_admin', scope: 'platform',
      home_company: 'humanizar', acting_company: 'humanizar', platform_override: false,
    });
  });

  it('GET /v3/auth/session devuelve company_owner para Miguel', async () => {
    expect(await sessionAuthority(MIGUEL_EMAIL)).toEqual({
      role: 'company_owner', scope: 'company',
      home_company: 'humanizar', acting_company: 'humanizar', platform_override: false,
    });
  });

  it('sin cookie la sesión se informa no autenticada', async () => {
    const response = await fetch(`${httpUrl}/v3/auth/session`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false, login_mode: 'password' });
  });
});
