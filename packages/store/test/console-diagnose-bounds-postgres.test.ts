import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CauceRepository } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { buildTestGateway } from '../../../services/gateway/src/test-support/gateway-doubles.js';

interface Diagnosis { items: { type: string; id: string; application_error_code?: string | null }[]; truncated: boolean }
const PASSWORD = 'diagnose-bounds-fixture-password';
const TIME = '2025-01-01T00:00:00Z';
const PRIVATE = 'zz-canary-diagnose-private-error';
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined;
let app: FastifyInstance | undefined; let passwordHash: string | undefined;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let cookie: string;

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(requireValue(database, 'database'));
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl);
  passwordHash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await current.adminPool.query('UPDATE console_users SET password_hash=$1', [passwordHash]);
  app = await buildTestGateway({ pool: current.pool, repository: new CauceRepository(current.pool),
    authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(current.pool), signingKey: Buffer.alloc(32, 39) }) });
  cookie = await login();
});
afterEach(async () => { await app?.close(); app = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function server() { return requireValue(app, 'gateway'); }
function admin() { return requireValue(current, 'case database').adminPool; }
function fixture(index = 0) { return requireValue(fixtures[index], 'identity'); }
async function login(index = 0) {
  const response = await server().inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: 'http://localhost' },
    payload: { email: `${fixture(index).company_id}@dev.example`, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  const value = response.headers['set-cookie'];
  return requireValue(Array.isArray(value) ? value[0] : value, 'cookie').split(';', 1)[0] ?? '';
}
function diagnose(trace: string, session = cookie): Promise<LightMyRequestResponse> {
  return server().inject({ method: 'GET', url: `/v3/console/diagnose/${trace}`, headers: { cookie: session } }).then(value => value);
}
async function seedAudit(trace: string, index = 0, metadata: Record<string, unknown> = {}) {
  const value = fixture(index);
  await admin().query(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,trace_id,action,decision,metadata,created_at)
    VALUES($1,$2,$3,$4,'context.version','info',$5::jsonb,$6)`,
  [value.company_id, value.tenant_id, value.alias, trace, JSON.stringify(metadata), TIME]);
}
async function blockedQueries() {
  return (await admin().query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
    WHERE datname=current_database() AND query LIKE 'WITH context_refs AS%' AND wait_event_type='Lock'`)).rows;
}

describe('bounded diagnosis through signed sessions and real PostgreSQL', () => {
  it.each(['native_context_conflict', 'context_runtime_verification_failed', PRIVATE])('projects only known application errors: %s', async error => {
    const value = fixture(); const trace = `zz-canary-diagnose-${randomUUID()}`;
    await admin().query(`INSERT INTO agent_context_versions(company_id,tenant_id,alias,version,files,digest,source,actor_human_id,actor_alias,created_at)
      VALUES($1,$2,$3,1,'[]'::jsonb,$4,'ui',$5,'owner',$6)`,
    [value.company_id, value.tenant_id, value.alias, 'c'.repeat(64), value.human_id, TIME]);
    await admin().query('INSERT INTO agent_context_state(company_id,tenant_id,alias,desired_version) VALUES($1,$2,$3,1)',
      [value.company_id, value.tenant_id, value.alias]);
    await admin().query(`INSERT INTO agent_context_outbox(company_id,tenant_id,alias,version,state,apply_error)
      VALUES($1,$2,$3,1,'error',$4)`, [value.company_id, value.tenant_id, value.alias, error]);
    await seedAudit(trace, 0, { target_tenant: value.tenant_id, target_alias: value.alias, version: 1 });
    const response = await diagnose(trace); expect(response.statusCode).toBe(200);
    expect(response.json<Diagnosis>().items.find(item => item.type === 'context')).toMatchObject({
      application_error_code: error === PRIVATE ? null : error,
    });
    expect(response.body).not.toContain(PRIVATE);
  });
  it('orders simultaneous decimal identifiers numerically without losing bigint precision', async () => {
    const trace = `zz-canary-diagnose-${randomUUID()}`; const value = fixture();
    const ids = ['10', '2', '9007199254740994', '9007199254740993'];
    await admin().query(`INSERT INTO audit_events(id,company_id,tenant_id,actor_alias,trace_id,action,decision,created_at)
      SELECT id::bigint,$2,$3,$4,$5,'delivery.ack','info',$6 FROM unnest($1::text[]) id`,
    [ids, value.company_id, value.tenant_id, value.alias, trace, TIME]);
    const response = await diagnose(trace); expect(response.statusCode).toBe(200);
    expect(response.json<Diagnosis>().items.map(item => item.id)).toEqual(['2', '10', '9007199254740993', '9007199254740994']);
  });
  it('ignores malformed legacy references before casting frontier identifiers', async () => {
    const trace = `zz-canary-diagnose-${randomUUID()}`; const value = fixture();
    await seedAudit(trace, 0, { operation_id: PRIVATE, session_id: PRIVATE, backup_id: PRIVATE, delivery_id: PRIVATE,
      target_tenant: value.tenant_id, target_alias: value.alias, version: '9999999999999999999' });
    const response = await diagnose(trace); expect(response.statusCode).toBe(200);
    expect(response.json<Diagnosis>().items).toEqual([expect.objectContaining({ type: 'audit' })]);
    expect(response.body).not.toContain(PRIVATE);
  });
  it('uses the same numeric tie order when limiting the initial chain frontier', async () => {
    const trace = `zz-canary-diagnose-${randomUUID()}`; const value = fixture();
    await admin().query(`INSERT INTO audit_events(id,company_id,tenant_id,actor_alias,trace_id,action,decision,created_at)
      SELECT id,$1,$2,$3,$4,'delivery.ack','info',$5 FROM generate_series(1,502) id`,
    [value.company_id, value.tenant_id, value.alias, trace, TIME]);
    const response = await diagnose(trace); expect(response.statusCode).toBe(200);
    const body = response.json<Diagnosis>(); expect(body.truncated).toBe(true);
    expect(body.items.map(item => item.id)).toEqual(Array.from({ length: 500 }, (_, index) => String(index + 1)));
  });
  it('shares two slots across login sessions of one human and keeps another human independent', async () => {
    const trace = `zz-canary-diagnose-${randomUUID()}`; const peer = `zz-canary-peer-${randomUUID()}`;
    await seedAudit(trace); await seedAudit(peer, 1);
    const secondCookie = await login(); const peerCookie = await login(1);
    expect(secondCookie).not.toBe(cookie);
    const lock = await admin().connect(); const pending: Promise<LightMyRequestResponse>[] = [];
    try {
      await lock.query('BEGIN'); await lock.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
      pending.push(diagnose(trace), diagnose(trace, secondCookie));
      await vi.waitFor(async () => { expect(await blockedQueries()).toHaveLength(2); }, { timeout: 2_500, interval: 20 });
      const rejected = await diagnose(trace, secondCookie);
      expect(rejected.statusCode).toBe(429); expect(rejected.headers['retry-after']).toBe('1');
      expect(await blockedQueries()).toHaveLength(2);
      pending.push(diagnose(peer, peerCookie));
      await vi.waitFor(async () => { expect(await blockedQueries()).toHaveLength(3); }, { timeout: 2_500, interval: 20 });
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    expect((await Promise.all(pending)).map(response => response.statusCode)).toEqual([200, 200, 200]);
    expect((await diagnose(trace)).statusCode).toBe(200);
    for (let index = 0; index < 3; index += 1) expect((await diagnose(`zz-canary-missing-${randomUUID()}`)).statusCode).toBe(404);
    expect((await diagnose(trace)).statusCode).toBe(200);
  });
  it('cancels a disconnected HTTP request in PostgreSQL and returns its human slot', async () => {
    const trace = `zz-canary-diagnose-${randomUUID()}`; await seedAudit(trace);
    const address = await server().listen({ port: 0, host: '127.0.0.1' });
    const lock = await admin().connect(); const pending: Promise<LightMyRequestResponse>[] = [];
    let disconnected: ReturnType<typeof request> | undefined;
    const attempts: Promise<LightMyRequestResponse>[] = [];
    try {
      await lock.query('BEGIN'); await lock.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
      pending.push(diagnose(trace));
      await vi.waitFor(async () => { expect(await blockedQueries()).toHaveLength(1); }, { timeout: 2_500, interval: 20 });
      disconnected = request(`${address}/v3/console/diagnose/${trace}`, { headers: { cookie } });
      const closed = new Promise<void>(resolve => { disconnected?.once('error', () => { resolve(); }); });
      disconnected.end();
      await vi.waitFor(async () => { expect(await blockedQueries()).toHaveLength(2); }, { timeout: 2_500, interval: 20 });
      disconnected.destroy(); await closed;
      await vi.waitFor(async () => { expect(await blockedQueries()).toHaveLength(1); }, { timeout: 2_500, interval: 20 });
      let replacement: Promise<LightMyRequestResponse> | undefined;
      let replacementStatus: number | undefined;
      await vi.waitFor(async () => {
        if (replacement === undefined) {
          replacementStatus = undefined;
          replacement = diagnose(trace).then(response => { replacementStatus = response.statusCode; return response; });
          attempts.push(replacement);
        }
        if (replacementStatus !== undefined) {
          expect(replacementStatus).toBe(429); replacement = undefined;
        }
        expect(await blockedQueries()).toHaveLength(2);
      }, { timeout: 2_500, interval: 20 });
      pending.push(requireValue(replacement, 'replacement diagnostic request'));
    } finally { disconnected?.destroy(); await lock.query('ROLLBACK'); lock.release(); }
    expect((await Promise.all(pending)).map(response => response.statusCode)).toEqual([200, 200]);
    expect((await Promise.all(attempts)).map(response => response.statusCode)).toEqual(
      [...Array.from({ length: attempts.length - 1 }, () => 429), 200]);
    expect(requireValue(current, 'case database').pool.waitingCount).toBe(0);
    expect((await diagnose(trace)).statusCode).toBe(200);
  });
});
