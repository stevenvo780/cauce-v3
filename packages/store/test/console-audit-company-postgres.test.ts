import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { buildTestGateway } from '../../../services/gateway/src/test-support/gateway-doubles.js';

interface Identity { company_id: string; tenant_id: string; alias: string; human_id: string }
interface AuditBody { items: { action: string; company_id: string | null; tenant_id: string; trace_id: string | null }[] }
const PASSWORD = 'audit-company-fixture-password'; const ORIGIN = 'http://localhost'; const TIME = '2025-01-01T00:00:00.000Z';
const ALPHA_TRACE = 'zz-canary-audit-alpha'; const BETA_TRACE = 'zz-canary-audit-beta';
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: readonly Identity[]; let app: FastifyInstance | undefined; let passwordHash: string | undefined; let cookie: string;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl);
  passwordHash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await current.adminPool.query('UPDATE console_users SET password_hash=$1', [passwordHash]);
  const [alpha, beta] = fixtures;
  if (!alpha || !beta) throw new Error('company fixtures unavailable');
  await current.adminPool.query(`INSERT INTO tenants(id,company_id) VALUES('ContextAlphaDos',$1)
    ON CONFLICT (id) DO UPDATE SET company_id=EXCLUDED.company_id`, [alpha.company_id]);
  const insert = `INSERT INTO audit_events(company_id,tenant_id,actor_alias,trace_id,action,decision,metadata,created_at)
    VALUES($1,$2,$3,$4,$5,'allow',$6::jsonb,$7)`;
  const meta = JSON.stringify({ component: 'delivery', state: 'pending', summary: 'Operación de consola' });
  await current.adminPool.query(insert, [alpha.company_id, alpha.tenant_id, alpha.alias, ALPHA_TRACE, 'zz.canary.alpha', meta, TIME]);
  await current.adminPool.query(insert, [alpha.company_id, 'ContextAlphaDos', alpha.alias, null, 'zz.canary.alpha-segundo-tenant', meta, TIME]);
  await current.adminPool.query(insert, [beta.company_id, beta.tenant_id, beta.alias, BETA_TRACE, 'zz.canary.beta', meta, TIME]);
  await current.adminPool.query(
    `INSERT INTO audit_events(company_id,tenant_id,actor_alias,trace_id,action,decision,metadata,created_at)
     VALUES(NULL,$1,$2,$3,'zz.canary.legacy-beta','allow',$4::jsonb,$5)`,
    [beta.tenant_id, beta.alias, 'zz-canary-audit-legacy', meta, TIME]);
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 29) });
  app = await buildTestGateway({ pool, repository: new CauceRepository(pool), authProvider: provider });
  const response = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN },
    payload: { email: `${alpha.company_id}@dev.example`, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie']; const first = Array.isArray(header) ? header[0] : header;
  if (!first) throw new Error('session cookie unavailable');
  cookie = first.split(';', 1)[0] ?? '';
});
afterEach(async () => { await app?.close(); app = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

describe('console audit list scoped by company in real PostgreSQL', () => {
  it('devuelve solo filas de la empresa del humano, incluidas las de otro tenant de la misma empresa', async () => {
    if (!app) throw new Error('gateway unavailable');
    const response = await app.inject({ method: 'GET', url: '/v3/console/audit?limit=50', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json<AuditBody>();
    const actions = body.items.map(item => item.action);
    expect(actions).toContain('zz.canary.alpha');
    expect(actions).toContain('zz.canary.alpha-segundo-tenant');
    expect(actions).not.toContain('zz.canary.beta');
    expect(actions).not.toContain('zz.canary.legacy-beta');
    expect(body.items.every(item => item.company_id === fixtures[0]?.company_id)).toBe(true);
  });

  it('filtrar por la traza de otra empresa devuelve vacío, y por la propia devuelve su fila', async () => {
    if (!app) throw new Error('gateway unavailable');
    const foreign = await app.inject({ method: 'GET', url: `/v3/console/audit?trace_id=${BETA_TRACE}`, headers: { cookie } });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json<AuditBody>().items).toEqual([]);
    const own = await app.inject({ method: 'GET', url: `/v3/console/audit?trace_id=${ALPHA_TRACE}`, headers: { cookie } });
    expect(own.statusCode).toBe(200);
    expect(own.json<AuditBody>().items).toEqual([
      expect.objectContaining({ action: 'zz.canary.alpha', trace_id: ALPHA_TRACE, tenant_id: fixtures[0]?.tenant_id }),
    ]);
  });
});
